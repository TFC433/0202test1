/* [v7.2.0] Announcement Service SQL-Enabled */
/**
 * services/announcement-service.js
 * 布告欄業務邏輯層
 * * @version 7.2.0 (SQL First Read Enabled)
 * @date 2026-02-02
 * @description 
 * [SQL-Ready Refactor]
 * 1. 啟用 SQL First Read (_fetchInternal)。
 * 2. 實作 Sheet Fallback 機制。
 * 3. 維持 Write rowIndex 保護，確保 SQL 資料不誤入寫入流程。
 */

class AnnouncementService {
    /**
     * @param {Object} dependencies
     * @param {AnnouncementReader} dependencies.announcementReader
     * @param {AnnouncementSqlReader} dependencies.announcementSqlReader [New]
     * @param {AnnouncementWriter} dependencies.announcementWriter
     */
    constructor({ announcementReader, announcementSqlReader, announcementWriter }) {
        this.announcementReader = announcementReader;
        this.announcementSqlReader = announcementSqlReader; // [New] Inject SQL Reader
        this.announcementWriter = announcementWriter;
    }

    // ============================================================
    //  Internal Accessor (Read Convergence)
    // ============================================================

    /**
     * [Internal] 唯一資料讀取收斂點
     * 實作 SQL First -> Sheet Fallback 策略
     * @returns {Promise<Array>} Raw Announcement Data
     */
    async _fetchInternal() {
        // [SQL First Path]
        try {
            if (this.announcementSqlReader) {
                // 直接回傳 DTO (資料契約已由 Reader 層對齊)
                return await this.announcementSqlReader.getAnnouncements();
            }
        } catch (error) {
            console.warn(`[AnnouncementService] SQL Read Failed, falling back to Sheet: ${error.message}`);
            // Fallback continues below...
        }

        // [Sheet Fallback Path]
        return this.announcementReader.getAnnouncements();
    }

    // ============================================================
    //  Public Methods
    // ============================================================

    /**
     * 取得所有已發布公告 (含置頂排序)
     * @returns {Promise<Array>}
     */
    async getAnnouncements() {
        try {
            // 1. 取得 Raw Data (透過收斂點)
            let data = await this._fetchInternal();
            
            // 2. 業務過濾：僅顯示已發布
            data = data.filter(item => item.status === '已發布');

            // 3. 業務排序：置頂優先 > 最後更新時間
            data.sort((a, b) => {
                // 置頂判斷
                if (a.isPinned && !b.isPinned) return -1;
                if (!a.isPinned && b.isPinned) return 1;
                
                // 時間排序 (Desc)
                const dateA = new Date(a.lastUpdateTime || 0);
                const dateB = new Date(b.lastUpdateTime || 0);
                return dateB - dateA;
            });

            return data;
        } catch (error) {
            console.error('[AnnouncementService] getAnnouncements Error:', error);
            throw error;
        }
    }

    /**
     * 建立新公告
     * @param {Object} data - 公告資料
     * @param {Object} user - 建立者使用者物件
     */
    async createAnnouncement(data, user) {
        try {
            const creatorName = user.displayName || user.username || user.name || 'System';
            
            // 業務驗證
            if (!data.title) {
                throw new Error('公告標題為必填');
            }

            const result = await this.announcementWriter.createAnnouncement(data, creatorName);
            return result;
        } catch (error) {
            console.error('[AnnouncementService] createAnnouncement Error:', error);
            throw error;
        }
    }

    /**
     * 更新公告
     * @param {string} id - 公告 ID
     * @param {Object} data - 更新資料
     * @param {Object} user - 操作者
     */
    async updateAnnouncement(id, data, user) {
        try {
            const modifierName = user.displayName || user.username || user.name || 'System';

            // 1. 查找公告 (透過收斂點)
            const allAnnouncements = await this._fetchInternal();
            const target = allAnnouncements.find(a => a.id === id);

            if (!target) {
                throw new Error(`找不到公告 ID: ${id}`);
            }

            // [Write Protection] 確保資料來源支援 rowIndex (Sheet Only)
            if (!target.rowIndex) {
                throw new Error('[Forbidden] 無法更新 SQL 來源的資料 (Missing rowIndex)。請切換回 Sheet 模式或聯絡管理員。');
            }

            const rowIndex = target.rowIndex;

            const result = await this.announcementWriter.updateAnnouncement(rowIndex, data, modifierName);
            return result;
        } catch (error) {
            console.error('[AnnouncementService] updateAnnouncement Error:', error);
            throw error;
        }
    }

    /**
     * 刪除公告
     * @param {string} id - 公告 ID
     */
    async deleteAnnouncement(id) {
        try {
            // 1. 查找公告 (透過收斂點)
            const allAnnouncements = await this._fetchInternal();
            const target = allAnnouncements.find(a => a.id === id);

            if (!target) {
                throw new Error(`找不到公告 ID: ${id}`);
            }

            // [Write Protection] 確保資料來源支援 rowIndex (Sheet Only)
            if (!target.rowIndex) {
                throw new Error('[Forbidden] 無法刪除 SQL 來源的資料 (Missing rowIndex)。請切換回 Sheet 模式或聯絡管理員。');
            }

            const rowIndex = target.rowIndex;
            const result = await this.announcementWriter.deleteAnnouncement(rowIndex);
            return result;
        } catch (error) {
            console.error('[AnnouncementService] deleteAnnouncement Error:', error);
            throw error;
        }
    }
}

module.exports = AnnouncementService;