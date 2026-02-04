/**
 * services/contact-service.js
 * 聯絡人業務邏輯服務層
 * * @version 7.3.1 (Phase 7: Dashboard Interface Support)
 * @date 2026-02-04
 * @description
 * - Official Contacts: SQL primary read, Sheet fallback via CORE reader only.
 * - Official Contacts write: SQL only via contactSqlWriter.
 * - Potential Contacts (RAW): stays on Sheet via RAW reader/writer.
 */

class ContactService {
    /**
     * @param {ContactReader} contactRawReader  - bound to IDS.RAW (Potential contacts)
     * @param {ContactReader} contactCoreReader - bound to IDS.CORE (Official list + link table)
     * @param {ContactWriter} contactWriter     - RAW write only
     * @param {CompanyReader} companyReader
     * @param {Object} config
     * @param {ContactSqlReader} [contactSqlReader]
     * @param {ContactSqlWriter} [contactSqlWriter]
     */
    constructor(contactRawReader, contactCoreReader, contactWriter, companyReader, config, contactSqlReader, contactSqlWriter) {
        this.contactRawReader = contactRawReader;
        this.contactCoreReader = contactCoreReader;
        this.contactWriter = contactWriter;
        this.companyReader = companyReader;
        this.config = config || { PAGINATION: { CONTACTS_PER_PAGE: 20 } };
        this.contactSqlReader = contactSqlReader;
        this.contactSqlWriter = contactSqlWriter;
    }

    _normalizeKey(str = '') {
        return String(str).toLowerCase().trim();
    }

    _mapSqlContact(contact) {
        return {
            ...contact,
            position: contact.jobTitle || contact.position
        };
    }

    _mapOfficialContact(contact, companyNameMap) {
        return {
            ...contact,
            companyName: companyNameMap.get(contact.companyId) || contact.companyId
        };
    }

    async _fetchOfficialContactsWithCompanies(forceSheet = false) {
        let allContacts = null;

        // 1) SQL primary
        if (!forceSheet) {
            if (this.contactSqlReader) {
                try {
                    const sqlContacts = await this.contactSqlReader.getContacts();
                    if (!sqlContacts || sqlContacts.length === 0) {
                        throw new Error('SQL returned empty data or null (Treating as sync lag)');
                    }
                    allContacts = sqlContacts.map(c => this._mapSqlContact(c));
                } catch (error) {
                    console.warn('[ContactService] SQL Read Error/Empty (Fallback to Sheet):', error.message);
                    allContacts = null;
                }
            } else {
                console.warn('[ContactService] SQL Reader NOT injected. Skipping to Sheet.');
            }
        }

        // 2) Sheet fallback (MUST be CORE reader)
        if (!allContacts) {
            if (!this.contactCoreReader) {
                throw new Error('[ContactService] contactCoreReader not configured for Sheet fallback');
            }
            allContacts = await this.contactCoreReader.getContactList();
        }

        // 3) Join companies
        const allCompanies = await this.companyReader.getCompanyList();
        const companyNameMap = new Map(allCompanies.map(c => [c.companyId, c.companyName]));

        return allContacts.map(contact => this._mapOfficialContact(contact, companyNameMap));
    }

    async _resolveContactRowIndex(contactId) {
        // Deprecated in Phase 7 writes, but if ever used, must read CORE
        if (!this.contactCoreReader) throw new Error('[ContactService] contactCoreReader not configured');
        const allContacts = await this.contactCoreReader.getContactList();
        const target = allContacts.find(c => c.contactId === contactId);

        if (!target) throw new Error(`Contact ID not found: ${contactId}`);
        if (!target.rowIndex) throw new Error(`System Error: Missing rowIndex for Contact ${contactId}`);
        return target.rowIndex;
    }

    /**
     * [Phase 7 Dashboard Interface]
     * 提供儀表板所需的完整正式聯絡人清單
     * 封裝 SQL/Sheet 混合讀取邏輯
     * @returns {Promise<Array>} 成功回傳聯絡人陣列，失敗回傳空陣列
     */
    async getAllOfficialContacts() {
        try {
            return await this._fetchOfficialContactsWithCompanies();
        } catch (error) {
            console.error('[ContactService] getAllOfficialContacts Failed:', error);
            return []; // Fail-safe
        }
    }

    async getDashboardStats() {
        try {
            if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');
            const contacts = await this.contactRawReader.getContacts();
            return {
                total: contacts.length,
                pending: contacts.filter(c => !c.status || c.status === 'Pending').length,
                processed: contacts.filter(c => c.status === 'Processed').length,
                dropped: contacts.filter(c => c.status === 'Dropped').length
            };
        } catch (error) {
            console.error('[ContactService] getDashboardStats Error:', error);
            return { total: 0, pending: 0, processed: 0, dropped: 0 };
        }
    }

    async getPotentialContacts(limit = 2000) {
        if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');
        let contacts = await this.contactRawReader.getContacts();

        contacts = contacts.filter(c => c.name || c.company);

        contacts.sort((a, b) => {
            const dateA = new Date(a.createdTime);
            const dateB = new Date(b.createdTime);
            if (isNaN(dateB.getTime())) return -1;
            if (isNaN(dateA.getTime())) return 1;
            return dateB - dateA;
        });

        if (limit > 0) contacts = contacts.slice(0, limit);
        return contacts;
    }

    async searchContacts(query) {
        try {
            let contacts = await this.getPotentialContacts(9999);
            if (query) {
                const searchTerm = query.toLowerCase();
                contacts = contacts.filter(c =>
                    (c.name && c.name.toLowerCase().includes(searchTerm)) ||
                    (c.company && c.company.toLowerCase().includes(searchTerm))
                );
            }
            return { data: contacts };
        } catch (error) {
            console.error('[ContactService] searchContacts Error:', error);
            throw error;
        }
    }

    async searchOfficialContacts(query, page = 1) {
        try {
            let contacts = await this._fetchOfficialContactsWithCompanies();

            if (query) {
                const searchTerm = query.toLowerCase();
                contacts = contacts.filter(c =>
                    (c.name && c.name.toLowerCase().includes(searchTerm)) ||
                    (c.companyName && c.companyName.toLowerCase().includes(searchTerm))
                );
            }

            const pageSize = (this.config && this.config.PAGINATION) ? this.config.PAGINATION.CONTACTS_PER_PAGE : 20;
            const startIndex = (page - 1) * pageSize;
            const paginated = contacts.slice(startIndex, startIndex + pageSize);

            return {
                data: paginated,
                pagination: {
                    current: page,
                    total: Math.ceil(contacts.length / pageSize),
                    totalItems: contacts.length,
                    hasNext: (startIndex + pageSize) < contacts.length,
                    hasPrev: page > 1
                }
            };
        } catch (error) {
            console.error('[ContactService] searchOfficialContacts Error:', error);
            throw error;
        }
    }

    async getContactById(contactId) {
        // SQL primary
        if (this.contactSqlReader) {
            try {
                const sqlContact = await this.contactSqlReader.getContactById(contactId);
                if (sqlContact) {
                    const allCompanies = await this.companyReader.getCompanyList();
                    const companyNameMap = new Map(allCompanies.map(c => [c.companyId, c.companyName]));
                    const mappedContact = this._mapSqlContact(sqlContact);
                    return this._mapOfficialContact(mappedContact, companyNameMap);
                }
                console.warn(`[ContactService] Contact ID ${contactId} not found in SQL. Attempting Fallback.`);
            } catch (error) {
                console.warn('[ContactService] SQL Single Read Error (Fallback):', error.message);
            }
        } else {
            console.warn('[ContactService] SQL Reader NOT injected. Using Sheet Fallback for getContactById.');
        }

        // CORE sheet fallback
        const contacts = await this._fetchOfficialContactsWithCompanies(true);
        const contact = contacts.find(c => c.contactId === contactId);
        return contact || null;
    }

    async getLinkedContacts(opportunityId) {
        try {
            if (!this.contactCoreReader) throw new Error('[ContactService] contactCoreReader not configured');
            if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');

            const [allLinks, officialContacts, allPotentialContacts] = await Promise.all([
                this.contactCoreReader.getAllOppContactLinks(),   // ✅ CORE
                this._fetchOfficialContactsWithCompanies(),       // SQL primary
                this.contactRawReader.getContacts()               // ✅ RAW (images)
            ]);

            const linkedContactIds = new Set();
            for (const link of allLinks) {
                if (link.opportunityId === opportunityId && link.status === 'active') {
                    linkedContactIds.add(link.contactId);
                }
            }
            if (linkedContactIds.size === 0) return [];

            const potentialCardMap = new Map();
            allPotentialContacts.forEach(pc => {
                if (pc.name && pc.company && pc.driveLink) {
                    const key = this._normalizeKey(pc.name) + '|' + this._normalizeKey(pc.company);
                    if (!potentialCardMap.has(key)) potentialCardMap.set(key, pc.driveLink);
                }
            });

            return officialContacts
                .filter(contact => linkedContactIds.has(contact.contactId))
                .map(contact => {
                    const companyName = contact.companyName || '';
                    let driveLink = '';

                    if (contact.name && companyName) {
                        const key = this._normalizeKey(contact.name) + '|' + this._normalizeKey(companyName);
                        driveLink = potentialCardMap.get(key) || '';
                    }

                    return {
                        contactId: contact.contactId,
                        sourceId: contact.sourceId,
                        name: contact.name,
                        companyId: contact.companyId,
                        department: contact.department,
                        position: contact.position,
                        mobile: contact.mobile,
                        phone: contact.phone,
                        email: contact.email,
                        companyName,
                        driveLink
                    };
                });

        } catch (error) {
            console.error('[ContactService] getLinkedContacts Error:', error);
            return [];
        }
    }

    // ----------------------------
    // Phase 7 Writes (SQL Only)
    // ----------------------------
    async createContact(contactData, user) {
        if (!this.contactSqlWriter) throw new Error('[ContactService] ContactSqlWriter not configured. Create failed.');

        const result = await this.contactSqlWriter.createContact(contactData, user);

        // invalidate official cache (CORE reader)
        if (this.contactCoreReader && this.contactCoreReader.invalidateCache) {
            this.contactCoreReader.invalidateCache('contactList');
        }

        return result; // { success: true, id }
    }

    async updateContact(contactId, updateData, user) {
        if (!this.contactSqlWriter) throw new Error('[ContactService] ContactSqlWriter not configured. Update failed.');

        await this.contactSqlWriter.updateContact(contactId, updateData, user);

        if (this.contactCoreReader && this.contactCoreReader.invalidateCache) {
            this.contactCoreReader.invalidateCache('contactList');
        }

        return { success: true };
    }

    async deleteContact(contactId, user) {
        if (!this.contactSqlWriter) throw new Error('[ContactService] ContactSqlWriter not configured. Delete failed.');

        await this.contactSqlWriter.deleteContact(contactId);

        if (this.contactCoreReader && this.contactCoreReader.invalidateCache) {
            this.contactCoreReader.invalidateCache('contactList');
        }

        return { success: true };
    }

    // ----------------------------
    // RAW (Potential) stays Sheet
    // ----------------------------
    async updatePotentialContact(rowIndex, updateData, modifier) {
        try {
            if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');

            const allContacts = await this.contactRawReader.getContacts();
            const target = allContacts.find(c => c.rowIndex === parseInt(rowIndex));
            if (!target) throw new Error(`找不到潛在客戶 Row: ${rowIndex}`);

            const mergedData = { ...target, ...updateData };

            if (updateData.notes) {
                const oldNotes = target.notes || '';
                const newNoteEntry = `[${modifier} ${new Date().toLocaleDateString()}] ${updateData.notes}`;
                mergedData.notes = oldNotes ? `${oldNotes}\n${newNoteEntry}` : newNoteEntry;
            }

            await this.contactWriter.writePotentialContactRow(rowIndex, mergedData);

            if (this.contactRawReader.invalidateCache) {
                this.contactRawReader.invalidateCache('contacts');
            }

            return { success: true };
        } catch (error) {
            console.error('[ContactService] updatePotentialContact Error:', error);
            throw error;
        }
    }
}

module.exports = ContactService;