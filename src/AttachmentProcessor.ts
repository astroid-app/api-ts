import * as fs from 'fs/promises';
import * as path from 'path';
import { getDb } from './utils/pgsql';
import { Attachment } from './types/Attachment';
import { r } from 'surrealdb';

const ATTACHMENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS attachments (
    id text PRIMARY KEY,
    data jsonb NOT NULL
)
`;
let attachmentsTableEnsured = false;

async function ensureAttachmentsTable(client: any): Promise<void> {
    if (attachmentsTableEnsured) return;
    await client.query(ATTACHMENTS_TABLE_SQL);
    attachmentsTableEnsured = true;
}

async function getAttachment(client: any, attachmentId: string) {
    await ensureAttachmentsTable(client);
    const res = await client.query('SELECT data FROM attachments WHERE id = $1', [attachmentId]);
    return res.rows[0]?.data;
}

export async function downloadAttachment(attachmentUrl: string, registeredPlatforms: string[]): Promise<Attachment> {
    const res = await fetch(attachmentUrl);
    if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
    const contentLength = Number(res.headers.get('content-length')) || (await res.arrayBuffer()).byteLength;
    if (contentLength > 50 * 1024 * 1024) throw new Error("Attachment is too large. Maximum size is 50MB.");
    const idChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const attachmentId = Array.from({ length: 16 }, () => idChars[Math.floor(Math.random() * idChars.length)]).join('');
    let attachmentName = attachmentUrl.split('/').pop() || 'file';
    const extension = attachmentName.split('.').pop()?.split('?')[0].split('%3F')[0] || 'bin';
    const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        pdf: 'application/pdf',
        txt: 'text/plain',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        csv: 'text/csv',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        avi: 'video/x-msvideo',
        zip: 'application/zip',
        rar: 'application/vnd.rar',
        '7z': 'application/x-7z-compressed',
        json: 'application/json',
        svg: 'image/svg+xml',
        html: 'text/html',
        js: 'application/javascript',
        ts: 'application/typescript',
    };
    attachmentName = `${attachmentId}.${extension}`;
    const attachmentType = mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
    const tmpDir = path.resolve(__dirname, 'TMP_attachments');
    await fs.mkdir(tmpDir, { recursive: true });
    const attachmentPath = path.join(tmpDir, `${attachmentId}.${extension}`);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    try {
        await fs.writeFile(attachmentPath, buffer);
        console.log(`Attachment file written to ${attachmentPath}`);
    } catch (err) {
        console.error(`Failed to write attachment file: ${err}`);
        throw err;
    }

    const client = await getDb();
    try {
        await ensureAttachmentsTable(client);
        await client.query(
            'INSERT INTO attachments (id, data) VALUES ($1, $2)',
            [
                attachmentId,
                {
                    id: attachmentId,
                    name: attachmentName,
                    type: attachmentType,
                    size: contentLength,
                    path: attachmentPath,
                    status: 'downloaded',
                    registeredPlatforms,
                    createdAt: new Date().toISOString(),
                }
            ]
        );
        const data = await client.query(
            'SELECT data FROM attachments WHERE id = $1',
            [attachmentId]
        );
        return data.rows[0].data as Attachment;
    } finally {
        client.release();
    }
}

export async function checkAttachment(attachmentId: string): Promise<boolean | undefined> {
    const client = await getDb();
    try {
        const attachment = await getAttachment(client, attachmentId);
        if (!attachment) return undefined;
        if (attachment.sentBy.discord && attachment.sentBy.guilded && attachment.sentBy.revolt && attachment.sentBy.nerimity) {
            await updateAttachment(attachmentId, 'sent');
            return true;
        }
        return undefined;
    } finally {
        client.release();
    }
}

export async function clearTemporaryAttachments(): Promise<void> {
    const tmpDir = path.resolve(__dirname, 'TMP_attachments');
    let client;
    try {
        const files = await fs.readdir(tmpDir);
        client = await getDb();
        for (const file of files) {
            if (file === ".placeholder") continue;
            const attachmentId = file.split('.')[0];
            const attachment = await getAttachment(client, attachmentId);
            if (attachment) {
                try {
                    if (attachment.status === "sent" || attachment.status === "canDelete") {
                        const filePath = path.join(tmpDir, file);
                        await fs.unlink(filePath);
                        await client.query('DELETE FROM attachments WHERE id = $1', [attachmentId]);
                    }
                } catch (e) {
                    console.error(`Error deleting temporary attachments. Error: ${e}`);
                    throw new Error(`Error deleting temporary attachments. Error: ${e}`);
                }
            }
        }
    } catch (e) {
        console.error(`Error deleting temporary attachments. Error: ${e}`);
        throw new Error(`Error deleting temporary attachments. Error: ${e}`);
    } finally {
        if (client) client.release();
    }
}

export async function updateAttachment(attachmentId: string, status: 'sent' | 'canDelete'): Promise<void> {
    const client = await getDb();
    try {
        const attachment = await getAttachment(client, attachmentId);
        if (!attachment) throw new Error(`Attachment with ID ${attachmentId} not found`);
        if (attachment.status === 'downloaded') {
            attachment.status = status;
            await client.query('UPDATE attachments SET data = $1 WHERE id = $2', [attachment, attachmentId]);
        } else {
            throw new Error(`Attachment with ID ${attachmentId} is not in a downloadable state`);
        }
    } finally {
        client.release();
    }
}
