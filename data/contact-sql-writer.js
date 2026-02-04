/**
 * data/contact-sql-writer.js
 * [Phase 7-1/7-2] SQL Writer for Official Contacts
 * * @version 7.0.0
 * * @date 2026-02-04
 * * @description Strict SQL write operations for Official Contacts.
 * * Handles Create, Update, Delete with strict ID contracts.
 */

const { supabase } = require('../config/supabase');

class ContactSqlWriter {
    constructor() {
        this.tableName = 'contacts';
    }

    /**
     * Create Contact (SQL Only)
     * @param {Object} data - Contact DTO
     * @param {string} user - Creator name
     * @returns {Promise<Object>} { success: true, id: string }
     */
    async createContact(data, user) {
        // [Contract] Ensure ID exists. Pattern: C + Timestamp
        // Prioritize provided ID, else generate new.
        const contactId = data.contactId || data.id || `C${Date.now()}`;
        const now = new Date().toISOString();

        console.log(`👤 [ContactSqlWriter] Creating contact: ${data.name || 'Unnamed'} (ID: ${contactId})`);

        const payload = {
            contact_id: contactId,
            source_id: data.sourceId || 'MANUAL',
            name: data.name,
            company_id: data.companyId || data.company || null, // Handle both key styles
            department: data.department || '',
            job_title: data.jobTitle || data.position || '',      // Handle both key styles
            mobile: data.mobile || '',
            phone: data.phone || data.tel || '',                  // Handle both key styles
            email: data.email || '',
            created_by: user,
            updated_by: user,
            created_time: now,
            updated_time: now
        };

        const { error } = await supabase
            .from(this.tableName)
            .insert([payload]);

        if (error) {
            console.error('[ContactSqlWriter] Create Failed:', error);
            throw new Error(`[ContactSqlWriter] Create Error: ${error.message}`);
        }

        // [Contract] Must return { success, id } for WorkflowService compatibility
        return { success: true, id: contactId };
    }

    /**
     * Update Contact (SQL Only)
     * @param {string} contactId 
     * @param {Object} data - Partial update DTO
     * @param {string} user - Modifier name
     */
    async updateContact(contactId, data, user) {
        console.log(`👤 [ContactSqlWriter] Updating contact ${contactId} by ${user}`);

        const now = new Date().toISOString();
        const payload = {
            updated_time: now,
            updated_by: user
        };

        // Map Service fields (CamelCase) to SQL columns (snake_case)
        if (data.name !== undefined) payload.name = data.name;
        if (data.companyId !== undefined) payload.company_id = data.companyId;
        if (data.company !== undefined) payload.company_id = data.company; // Alias
        if (data.department !== undefined) payload.department = data.department;
        if (data.jobTitle !== undefined) payload.job_title = data.jobTitle;
        if (data.position !== undefined) payload.job_title = data.position; // Alias
        if (data.mobile !== undefined) payload.mobile = data.mobile;
        if (data.phone !== undefined) payload.phone = data.phone;
        if (data.tel !== undefined) payload.phone = data.tel; // Alias
        if (data.email !== undefined) payload.email = data.email;

        const { error } = await supabase
            .from(this.tableName)
            .update(payload)
            .eq('contact_id', contactId);

        if (error) {
            console.error('[ContactSqlWriter] Update Failed:', error);
            throw new Error(`[ContactSqlWriter] Update Error: ${error.message}`);
        }

        return { success: true };
    }

    /**
     * Delete Contact (SQL Only)
     * @param {string} contactId 
     */
    async deleteContact(contactId) {
        console.log(`🗑️ [ContactSqlWriter] Deleting contact ${contactId}`);

        const { error } = await supabase
            .from(this.tableName)
            .delete()
            .eq('contact_id', contactId);

        if (error) {
            console.error('[ContactSqlWriter] Delete Failed:', error);
            throw new Error(`[ContactSqlWriter] Delete Error: ${error.message}`);
        }

        return { success: true };
    }
}

module.exports = ContactSqlWriter;