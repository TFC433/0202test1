/* [v7.2.0] Weekly Service SQL-Bridge */
/**
 * services/weekly-business-service.js
 * 週間業務邏輯服務 (Service Layer)
 * * @version 7.2.0 (SQL Read Enable)
 * @date 2026-02-02
 * @description 
 * [SQL-Ready Refactor]
 * 1. 實作 SQL First Read 與 Fallback 機制 (_fetchInternal)。
 * 2. 實作雙重資料形狀適配 (Sheet/SQL) 與 View 契約對齊 (_normalizeEntry)。
 * 3. 實作 Write 保護機制，防止無 rowIndex 的 SQL 資料誤入寫入流程。
 */

class WeeklyBusinessService {
    /**
     * 透過 Service Container 注入依賴
     * [Refactor] 新增 weeklyBusinessSqlReader 注入
     */
    constructor({ 
        weeklyBusinessReader, 
        weeklyBusinessSqlReader, // [New] SQL Reader
        weeklyBusinessWriter, 
        dateHelpers, 
        calendarService, 
        systemReader,
        opportunityService, 
        config 
    }) {
        this.weeklyBusinessReader = weeklyBusinessReader;
        this.weeklyBusinessSqlReader = weeklyBusinessSqlReader; // [New]
        this.weeklyBusinessWriter = weeklyBusinessWriter;
        this.dateHelpers = dateHelpers;
        this.calendarService = calendarService;
        this.systemReader = systemReader;
        this.opportunityService = opportunityService;
        this.config = config;
    }

    // ============================================================
    //  Internal Accessor (Read Convergence & View Normalization)
    // ============================================================

    /**
     * [Internal] 唯一資料讀取收斂點
     * 實作 SQL First -> Sheet Fallback 策略
     * @param {string} mode - 'ENTRIES' | 'SUMMARY'
     * @returns {Promise<Array>} Normalized View Objects or Summary
     */
    async _fetchInternal(mode) {
        // 策略：嘗試使用 SQL Reader，若失敗則回退至 Sheet Reader
        try {
            if (this.weeklyBusinessSqlReader) {
                // [SQL First Path]
                if (mode === 'SUMMARY' || mode === 'ENTRIES') {
                     // SQL Reader 統一使用 getWeeklyBusinessEntries (DTO 包含 summaryContent)
                     const sqlEntries = await this.weeklyBusinessSqlReader.getWeeklyBusinessEntries();
                     
                     if (mode === 'SUMMARY') {
                         return sqlEntries; // SQL DTO 已包含 weekId, summaryContent
                     }
                     
                     // Mode ENTRIES: 進行正規化
                     return sqlEntries.map(entry => this._normalizeEntry(entry));
                }
            }
        } catch (error) {
            console.warn(`[WeeklyService] SQL Read Failed, falling back to Sheet: ${error.message}`);
            // Fallback continues below...
        }

        // [Sheet Fallback Path]
        if (mode === 'SUMMARY') {
            return this.weeklyBusinessReader.getWeeklySummary();
        }

        if (mode === 'ENTRIES') {
            const rawEntries = await this.weeklyBusinessReader.getAllEntries();
            return rawEntries.map(entry => this._normalizeEntry(entry));
        }

        return [];
    }

    /**
     * [Internal] View Object 正規化 & 契約橋接
     * 支援 Sheet (中文鍵) 與 SQL (英文鍵) 雙重輸入
     */
    _normalizeEntry(raw) {
        // 判定來源：若有 '日期' 則為 Sheet，否則嘗試適配 SQL DTO
        const isSheet = raw['日期'] !== undefined;
        
        // 1. 提取統一的內部邏輯欄位 (Service Logic)
        const date = isSheet ? raw['日期'] : raw.entryDate;
        const weekId = raw.weekId; // 兩者皆有
        const recordId = raw.recordId; // 兩者皆有 (SQL: recordId, Sheet: recordId)
        const rowIndex = isSheet ? raw.rowIndex : undefined; // SQL 無 rowIndex

        // 2. 構建對外契約 (View Contract)
        // 若為 SQL 來源，必須補齊前端依賴的中文鍵名 (API Shape Stability)
        let viewContract = {};
        if (isSheet) {
            viewContract = { ...raw };
        } else {
            // SQL DTO -> Sheet View Mapping
            viewContract = {
                ...raw,
                '日期': raw.entryDate || '',
                'weekId': raw.weekId || '',
                'category': raw.category || '',
                '主題': raw.topic || '',
                '參與人員': raw.participants || '',
                '重點摘要': raw.summaryContent || '',
                '待辦事項': raw.todoItems || '',
                'createdTime': raw.createdTime || '',
                'lastUpdateTime': raw.updatedTime || '', // Map updatedTime -> lastUpdateTime
                '建立者': raw.createdBy || '',
                'recordId': raw.recordId || ''
            };
        }

        return {
            ...viewContract, // [Contract] 確保對外欄位一致
            
            // [View Object] Service 內部邏輯專用
            date: date,
            weekId: weekId,
            recordId: recordId,
            rowIndex: rowIndex // [Critical] 用於寫入保護檢查
        };
    }

    // ============================================================
    //  Public Methods
    // ============================================================

    /**
     * 獲取特定週次的所有條目
     */
    async getEntriesForWeek(weekId) {
        try {
            // 1. 取得全量資料 (SQL First or Fallback)
            const allEntries = await this._fetchInternal('ENTRIES');
            
            // 2. Filter by weekId
            let entries = allEntries.filter(entry => entry.weekId === weekId);
            
            // 3. Sort by Date (Desc)
            entries.sort((a, b) => new Date(b.date) - new Date(a.date));

            // 4. Calculate 'day'
            entries = entries.map(entry => {
                let dayValue = -1;
                try {
                    const dateString = entry.date;
                    if (dateString && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
                        const [year, month, day] = dateString.split('-').map(Number);
                        const entryDateUTC = new Date(Date.UTC(year, month - 1, day));
                        if (!isNaN(entryDateUTC.getTime())) {
                            dayValue = entryDateUTC.getUTCDay();
                        }
                    }
                } catch (e) {
                    dayValue = -1;
                }

                return {
                    ...entry,
                    day: dayValue,
                    _view: { day: dayValue }
                };
            });

            return entries || [];
        } catch (error) {
            console.error(`[WeeklyService] getEntriesForWeek Error (${weekId}):`, error);
            return [];
        }
    }

    /**
     * 獲取週報列表摘要
     */
    async getWeeklyBusinessSummaryList() {
        try {
            // 透過收斂點取得 Summary (SQL DTO or Sheet Raw)
            // SQL DTO 也有 weekId, summaryContent，因此通用
            const rawData = await this._fetchInternal('SUMMARY');
            
            const weekSummaryMap = new Map();
            rawData.forEach(item => {
                const { weekId } = item;
                // 適配欄位：Sheet 用 summaryContent, SQL DTO 用 summaryContent (或需從 mapRowToDto 確認)
                // 假設 SQL Reader DTO 已經 normalize 成 camelCase 'summaryContent'
                const content = item.summaryContent || item['重點摘要'];

                if (weekId && /^\d{4}-W\d{2}$/.test(weekId)) {
                    if (!weekSummaryMap.has(weekId)) {
                        weekSummaryMap.set(weekId, { weekId: weekId, summaryCount: 0 });
                    }
                    if (content && content.trim() !== '') {
                        weekSummaryMap.get(weekId).summaryCount++;
                    }
                }
            });
            const summaryData = Array.from(weekSummaryMap.values());
            
            const weeksList = summaryData.map(item => {
                const weekId = item.weekId;
                const weekInfo = this.dateHelpers.getWeekInfo(weekId);
                
                return {
                    id: weekId,
                    title: weekInfo.title,
                    dateRange: weekInfo.dateRange,
                    summaryCount: item.summaryCount
                };
            });

            const today = new Date();
            const currentWeekId = this.dateHelpers.getWeekId(today);
            const currentWeekInfo = this.dateHelpers.getWeekInfo(currentWeekId);
            const hasCurrentWeek = weeksList.some(w => w.title === currentWeekInfo.title);

            if (!hasCurrentWeek) {
                 weeksList.unshift({
                     id: currentWeekId, 
                     title: currentWeekInfo.title,
                     dateRange: currentWeekInfo.dateRange,
                     summaryCount: 0
                 });
            }

            return weeksList.sort((a, b) => b.id.localeCompare(a.id));

        } catch (error) {
            console.error('[WeeklyService] getWeeklyBusinessSummaryList Error:', error);
            throw error;
        }
    }

    /**
     * 獲取單週詳細資料
     */
    async getWeeklyDetails(weekId, userId = null) {
        const weekInfo = this.dateHelpers.getWeekInfo(weekId);
        
        let entriesForWeek = await this.getEntriesForWeek(weekId);
        
        const firstDay = new Date(weekInfo.days[0].date + 'T00:00:00'); 
        const lastDay = new Date(weekInfo.days[weekInfo.days.length - 1].date + 'T00:00:00'); 
        const endQueryDate = new Date(lastDay.getTime() + 24 * 60 * 60 * 1000); 

        const queries = [
            this.calendarService.getHolidaysForPeriod(firstDay, endQueryDate), 
            this.systemReader.getSystemConfig() 
        ];

        if (this.config.PERSONAL_CALENDAR_ID) {
            queries.push(
                this.calendarService.getEventsForPeriod(firstDay, endQueryDate, this.config.PERSONAL_CALENDAR_ID)
            );
        } else {
            queries.push(Promise.resolve([]));
        }

        if (this.config.CALENDAR_ID) {
            queries.push(
                this.calendarService.getEventsForPeriod(firstDay, endQueryDate, this.config.CALENDAR_ID)
            );
        } else {
            queries.push(Promise.resolve([]));
        }

        const results = await Promise.all(queries);
        const holidays = results[0];
        const systemConfig = results[1] || {};
        const rawDxEvents = results[2] || []; 
        const rawAtEvents = results[3] || [];

        const rules = systemConfig['日曆篩選規則'] || [];
        const dxBlockRule = rules.find(r => r.value === 'DX_屏蔽關鍵字');
        const dxBlockKeywords = (dxBlockRule ? dxBlockRule.note : '').split(',').map(s => s.trim()).filter(Boolean);

        const atTransferRule = rules.find(r => r.value === 'AT_轉移關鍵字');
        const atTransferKeywords = (atTransferRule ? atTransferRule.note : '').split(',').map(s => s.trim()).filter(Boolean);

        const finalDxList = [];
        const finalAtList = [];

        rawDxEvents.forEach(evt => {
            const summary = evt.summary || '';
            const shouldBlock = dxBlockKeywords.some(kw => summary.includes(kw));
            if (!shouldBlock) finalDxList.push(evt);
        });

        rawAtEvents.forEach(evt => {
            const summary = evt.summary || '';
            const shouldTransfer = atTransferKeywords.some(kw => summary.includes(kw));
            if (shouldTransfer) finalDxList.push(evt);
            else finalAtList.push(evt);
        });

        const organizeEventsByDay = (events) => {
            const map = {};
            events.forEach(event => {
                const startVal = event.start.dateTime || event.start.date;
                if (!startVal) return;

                const eventDate = new Date(startVal);
                const dateKey = eventDate.toLocaleDateString('en-CA', { timeZone: this.config.TIMEZONE });

                if (!map[dateKey]) map[dateKey] = [];
                
                const isAllDay = !!event.start.date;
                const timeStr = isAllDay ? '全天' : eventDate.toLocaleTimeString('zh-TW', { timeZone: this.config.TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });

                map[dateKey].push({
                    summary: event.summary,
                    isAllDay: isAllDay,
                    time: timeStr,
                    htmlLink: event.htmlLink,
                    location: event.location,
                    description: event.description
                });
            });
            return map;
        };

        const dxEventsByDay = organizeEventsByDay(finalDxList);
        const atEventsByDay = organizeEventsByDay(finalAtList);

        weekInfo.days.forEach(day => {
            if (holidays.has(day.date)) day.holidayName = holidays.get(day.date);
            day.dxCalendarEvents = dxEventsByDay[day.date] || [];
            day.atCalendarEvents = atEventsByDay[day.date] || [];
        });

        return {
            id: weekId,
            ...weekInfo, 
            entries: entriesForWeek 
        };
    }

    /**
     * 獲取週次選項
     */
    async getWeekOptions() {
        const today = new Date();
        const prevWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

        const summaryData = await this._fetchInternal('SUMMARY');
        const existingWeekIds = new Set(summaryData.map(w => w.weekId));

        const options = [
            { id: this.dateHelpers.getWeekId(prevWeek), label: '上一週' },
            { id: this.dateHelpers.getWeekId(today),    label: '本週' },
            { id: this.dateHelpers.getWeekId(nextWeek), label: '下一週' }
        ];

        options.forEach(opt => {
            opt.disabled = existingWeekIds.has(opt.id);
        });

        return options;
    }

    /**
     * 建立週報
     */
    async createWeeklyBusinessEntry(data) {
        const entryDate = new Date(data.date || new Date());
        const weekId = this.dateHelpers.getWeekId(entryDate);
        
        const fullData = { 
            ...data, 
            weekId: weekId
        };
        
        const creator = data.creator || 'System';
        return this.weeklyBusinessWriter.createEntry(fullData, creator);
    }

    /**
     * 更新週報
     */
    async updateWeeklyBusinessEntry(recordId, data) {
        try {
            // 1. Service Lookup
            const allEntries = await this._fetchInternal('ENTRIES');
            const target = allEntries.find(e => e.recordId === recordId);
            
            if (!target) {
                throw new Error(`找不到紀錄 ID: ${recordId}`);
            }

            // [Write Protection] 確保資料來源支援 rowIndex (Sheet Only)
            if (!target.rowIndex) {
                throw new Error('[Forbidden] 無法更新 SQL 來源的資料 (Missing rowIndex)。請切換回 Sheet 模式或聯絡管理員。');
            }

            // 2. Pure Write
            const modifier = data.creator || 'System';
            return await this.weeklyBusinessWriter.updateEntryRow(target.rowIndex, data, modifier);
        } catch (error) {
            console.error('[WeeklyService] updateWeeklyBusinessEntry Error:', error);
            throw error;
        }
    }

    /**
     * 刪除週報
     */
    async deleteWeeklyBusinessEntry(recordId) {
        try {
            // 1. Service Lookup
            const allEntries = await this._fetchInternal('ENTRIES');
            const target = allEntries.find(e => e.recordId === recordId);
            
            if (!target) {
                throw new Error(`找不到紀錄 ID: ${recordId}`);
            }

            // [Write Protection] 確保資料來源支援 rowIndex (Sheet Only)
            if (!target.rowIndex) {
                throw new Error('[Forbidden] 無法刪除 SQL 來源的資料 (Missing rowIndex)。請切換回 Sheet 模式或聯絡管理員。');
            }

            // 2. Pure Write
            return await this.weeklyBusinessWriter.deleteEntryRow(target.rowIndex);
        } catch (error) {
            console.error('[WeeklyService] deleteWeeklyBusinessEntry Error:', error);
            throw error;
        }
    }
}

module.exports = WeeklyBusinessService;