import path from 'path';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { PPTXLoader } from '@langchain/community/document_loaders/fs/pptx';
import ExcelJS from 'exceljs';
import { parseOfficeAsync } from 'officeparser';

const DOCUMENT_FORMATS = {
    '.pdf': { name: 'PDF', truncationLabel: 'PDF' },
    '.docx': { name: 'Word Document', truncationLabel: 'Document' },
    '.xlsx': { name: 'Excel', truncationLabel: 'Spreadsheet' },
    '.pptx': { name: 'PowerPoint', truncationLabel: 'Presentation' },
    '.odt': { name: 'OpenDocument Text', truncationLabel: 'Document' },
    '.ods': { name: 'OpenDocument Spreadsheet', truncationLabel: 'Spreadsheet' },
    '.odp': { name: 'OpenDocument Presentation', truncationLabel: 'Presentation' },
} as const;

const LEGACY_OFFICE_REPLACEMENTS: Record<string, string> = {
    '.doc': '.docx',
    '.xls': '.xlsx',
    '.ppt': '.pptx',
};

type DocumentExtension = keyof typeof DOCUMENT_FORMATS;

export interface ExtractedDocumentText {
    text: string;
    name: string;
    truncationLabel: string;
    detail?: string;
}

export const READABLE_DOCUMENT_EXTENSIONS = new Set(Object.keys(DOCUMENT_FORMATS));

export function isReadableDocumentFile(filePath: string): boolean {
    return READABLE_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function getLegacyOfficeReplacement(filePath: string): string | undefined {
    return LEGACY_OFFICE_REPLACEMENTS[path.extname(filePath).toLowerCase()];
}

export async function extractDocumentText(filePath: string): Promise<ExtractedDocumentText> {
    const extension = path.extname(filePath).toLowerCase() as DocumentExtension;
    const format = DOCUMENT_FORMATS[extension];
    if (!format) {
        throw new Error(`Unsupported document format: ${extension || 'unknown'}`);
    }

    let text: string;
    let detail: string | undefined;

    switch (extension) {
        case '.pdf': {
            const docs = await new PDFLoader(filePath, { splitPages: false }).load();
            text = docs.map(doc => doc.pageContent).join('\n\n');
            const pageCount = (docs[0]?.metadata as any)?.pdf?.totalPages || docs.length;
            detail = `${pageCount} page(s)`;
            break;
        }
        case '.docx': {
            const docs = await new DocxLoader(filePath).load();
            text = docs.map(doc => doc.pageContent).join('\n\n');
            break;
        }
        case '.xlsx': {
            const spreadsheet = await extractSpreadsheetText(filePath);
            text = spreadsheet.text;
            detail = `${spreadsheet.sheetCount} sheet(s)`;
            break;
        }
        case '.pptx': {
            const docs = await new PPTXLoader(filePath).load();
            text = docs.map(doc => doc.pageContent).join('\n\n');
            break;
        }
        case '.odt':
        case '.ods':
        case '.odp':
            text = await parseOfficeAsync(await Bun.file(filePath).arrayBuffer());
            break;
    }

    return {
        text: sanitizeExtractedText(text),
        name: format.name,
        truncationLabel: format.truncationLabel,
        detail,
    };
}

function csvEscape(value: string): string {
    if (!value.includes(',') && !value.includes('"') && !value.includes('\n')) return value;
    return `"${value.replace(/"/g, '""')}"`;
}

async function extractSpreadsheetText(filePath: string): Promise<{ text: string; sheetCount: number }> {
    try {
        return await extractSpreadsheetTextStreaming(filePath);
    } catch {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sheetsText = workbook.worksheets.map(worksheet => {
            const rows: string[] = [];
            worksheet.eachRow(row => rows.push(formatSpreadsheetRow(row)));
            return `--- Sheet: ${worksheet.name} ---\n${rows.join('\n')}`;
        });
        return { text: sheetsText.join('\n\n'), sheetCount: workbook.worksheets.length };
    }
}

async function extractSpreadsheetTextStreaming(filePath: string): Promise<{ text: string; sheetCount: number }> {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
        sharedStrings: 'cache',
        styles: 'ignore',
        hyperlinks: 'ignore',
        worksheets: 'emit',
        entries: 'emit',
    });
    const sheetsText: string[] = [];
    let sheetCount = 0;

    for await (const worksheet of reader) {
        sheetCount++;
        const rows: string[] = [];
        for await (const row of worksheet) {
            rows.push(formatSpreadsheetRow(row));
        }
        sheetsText.push(`--- Sheet: ${(worksheet as any).name} ---\n${rows.join('\n')}`);
    }

    return { text: sheetsText.join('\n\n'), sheetCount };
}

function formatSpreadsheetRow(row: ExcelJS.Row): string {
    const cells: string[] = [];
    for (let column = 1; column <= row.cellCount; column++) {
        cells.push(csvEscape(row.getCell(column).text ?? ''));
    }
    return cells.join(',');
}

function sanitizeExtractedText(text: string): string {
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
