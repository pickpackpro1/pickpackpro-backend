import { Prisma } from "@prisma/client";

type InvoiceForPdf = Prisma.invoicesGetPayload<{
  include: {
    clients: true;
    invoice_line_items: true;
  };
}>;

type SettingsForPdf = {
  company_name: string;
  company_address: Prisma.JsonValue;
  vat_number: string | null;
  bank_details: Prisma.JsonValue;
  invoice_payment_terms_days: number;
};

type PdfPage = {
  commands: string[];
  y: number;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const RIGHT = PAGE_WIDTH - MARGIN;
const BOTTOM = 70;

function number(value: number) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function cleanPdfText(value: unknown) {
  return text(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7E]/g, " ");
}

function escapePdfText(value: unknown) {
  return cleanPdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function estimateTextWidth(value: unknown, size: number) {
  return cleanPdfText(value).length * size * 0.52;
}

function wrapText(value: unknown, maxChars: number, maxLines = 4) {
  const words = cleanPdfText(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(maxChars - 3, 1))}...`;
  }
  return lines.length ? lines : [""];
}

function drawText(page: PdfPage, x: number, y: number, value: unknown, size = 10, font = "F1", align: "left" | "right" = "left") {
  const safe = escapePdfText(value);
  if (!safe) return;
  const textX = align === "right" ? x - estimateTextWidth(value, size) : x;
  page.commands.push(`BT /${font} ${number(size)} Tf ${number(textX)} ${number(y)} Td (${safe}) Tj ET`);
}

function drawLine(page: PdfPage, x1: number, y1: number, x2: number, y2: number) {
  page.commands.push(`0.82 0.84 0.88 RG ${number(x1)} ${number(y1)} m ${number(x2)} ${number(y2)} l S`);
}

function drawFilledRect(page: PdfPage, x: number, y: number, width: number, height: number, shade = "0.95 0.96 0.98") {
  page.commands.push(`${shade} rg ${number(x)} ${number(y)} ${number(width)} ${number(height)} re f 0 0 0 rg`);
}

function formatCurrency(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `GBP ${amount.toFixed(2)}` : "GBP 0.00";
}

function formatDate(value: Date | null) {
  return value ? new Date(value).toLocaleDateString("en-GB") : "--";
}

function addressLines(address: Prisma.JsonValue | null | undefined) {
  if (typeof address === "string") return wrapText(address, 44, 4).filter(Boolean);
  if (Array.isArray(address)) return address.map(text).filter(Boolean);

  const data = record(address);
  const fullAddress = firstText(data.fullAddress, data.full_address, data.address, data.formatted);
  if (fullAddress) return wrapText(fullAddress, 44, 4).filter(Boolean);

  const ordered = [
    firstText(data.line1, data.addressLine1, data.address_line_1, data.address1, data.street),
    firstText(data.line2, data.addressLine2, data.address_line_2, data.address2),
    [firstText(data.city, data.town), firstText(data.county, data.state)].filter(Boolean).join(", "),
    firstText(data.postcode, data.postalCode, data.postal_code, data.zip),
    firstText(data.country),
  ].filter(Boolean);

  if (ordered.length) return ordered.flatMap((line) => wrapText(line, 44, 2)).filter(Boolean);
  return Object.values(data)
    .map(text)
    .filter(Boolean)
    .flatMap((line) => wrapText(line, 44, 2));
}

function bankDetails(bankDetails: Prisma.JsonValue | null | undefined) {
  const data = record(bankDetails);
  return {
    bankName: firstText(data.bankName, data.bank_name, data.bank, data.name),
    sortCode: firstText(data.sortCode, data.sort_code, data.sort),
    accountNumber: firstText(data.accountNumber, data.account_number, data.accountNo, data.account_no, data.account),
  };
}

function createPdf(pages: PdfPage[]) {
  const font1Obj = 3 + pages.length * 2;
  const font2Obj = font1Obj + 1;
  const objects: string[] = [];
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`;

  pages.forEach((page, index) => {
    const pageObj = 3 + index * 2;
    const contentObj = pageObj + 1;
    const stream = page.commands.join("\n");
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(PAGE_WIDTH)} ${number(PAGE_HEIGHT)}] ` +
      `/Resources << /Font << /F1 ${font1Obj} 0 R /F2 ${font2Obj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  objects[font1Obj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[font2Obj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index < objects.length; index++) {
    offsets[index] = Buffer.byteLength(pdf, "latin1");
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function drawCompanyHeader(page: PdfPage, invoice: InvoiceForPdf, settings: SettingsForPdf | null) {
  const companyName = text(settings?.company_name);
  const companyAddress = addressLines(settings?.company_address);
  const vatNumber = text(settings?.vat_number);
  const paymentTermsDays = Number(settings?.invoice_payment_terms_days);

  drawText(page, MARGIN, 790, companyName, 20, "F2");
  let y = 770;
  for (const line of companyAddress) {
    drawText(page, MARGIN, y, line, 9);
    y -= 12;
  }
  if (vatNumber) drawText(page, MARGIN, y - 2, `VAT Number: ${vatNumber}`, 9);

  drawText(page, RIGHT, 790, "INVOICE", 24, "F2", "right");
  drawText(page, RIGHT, 765, invoice.invoice_number, 12, "F2", "right");
  drawText(page, RIGHT, 745, `Invoice Date: ${formatDate(invoice.invoice_date)}`, 9, "F1", "right");
  drawText(page, RIGHT, 731, `Due Date: ${formatDate(invoice.due_date)}`, 9, "F1", "right");
  if (Number.isInteger(paymentTermsDays) && paymentTermsDays > 0) {
    drawText(page, RIGHT, 717, `Payment Terms: ${paymentTermsDays} days`, 9, "F1", "right");
  }
}

function drawBillTo(page: PdfPage, invoice: InvoiceForPdf, startY: number) {
  drawText(page, MARGIN, startY, "Billed To", 9, "F2");
  drawText(page, MARGIN, startY - 18, invoice.clients.company_name, 11, "F2");
  drawText(page, MARGIN, startY - 34, invoice.clients.email, 9);
}

function drawTableHeader(page: PdfPage, y: number, isClientInvoice: boolean) {
  drawFilledRect(page, MARGIN, y - 4, RIGHT - MARGIN, 20);
  drawText(page, MARGIN + 4, y + 2, "Description", 9, "F2");
  drawText(page, 330, y + 2, isClientInvoice ? "Unit" : "Qty", 9, "F2", "right");
  drawText(page, 410, y + 2, "Rate", 9, "F2", "right");
  drawText(page, isClientInvoice ? RIGHT : 488, y + 2, "Amount", 9, "F2", "right");
  if (!isClientInvoice) drawText(page, RIGHT, y + 2, "VAT", 9, "F2", "right");
  drawLine(page, MARGIN, y - 7, RIGHT, y - 7);
  page.y = y - 22;
}

function drawTotals(page: PdfPage, invoice: InvoiceForPdf, y: number, isClientInvoice: boolean) {
  const labelX = 410;
  const valueX = RIGHT;
  let currentY = y;
  if (!isClientInvoice) {
    drawText(page, labelX, currentY, "Subtotal", 10, "F1", "right");
    drawText(page, valueX, currentY, formatCurrency(invoice.subtotal), 10, "F1", "right");
    currentY -= 16;
    drawText(page, labelX, currentY, "VAT", 10, "F1", "right");
    drawText(page, valueX, currentY, formatCurrency(invoice.vat_amount), 10, "F1", "right");
    currentY -= 18;
  }
  drawLine(page, 360, currentY + 12, RIGHT, currentY + 12);
  drawText(page, labelX, currentY, "Total", 12, "F2", "right");
  drawText(page, valueX, currentY, formatCurrency(invoice.total), 12, "F2", "right");
  page.y = currentY - 28;
}

function drawPaymentDetails(page: PdfPage, invoice: InvoiceForPdf, settings: SettingsForPdf | null, y: number) {
  const bank = bankDetails(settings?.bank_details);
  drawFilledRect(page, MARGIN, y - 64, RIGHT - MARGIN, 82);
  drawText(page, MARGIN + 12, y, "Payment Details", 11, "F2");
  let currentY = y - 18;
  if (bank.bankName) {
    drawText(page, MARGIN + 12, currentY, `Bank Name: ${bank.bankName}`, 9);
    currentY -= 14;
  }
  if (bank.sortCode) {
    drawText(page, MARGIN + 12, currentY, `Sort Code: ${bank.sortCode}`, 9);
    currentY -= 14;
  }
  if (bank.accountNumber) {
    drawText(page, MARGIN + 12, currentY, `Account Number: ${bank.accountNumber}`, 9);
    currentY -= 14;
  }
  drawText(page, MARGIN + 12, currentY, `Reference: ${invoice.invoice_number}`, 9);
}

export function renderInvoicePdf(invoice: InvoiceForPdf, settings: SettingsForPdf | null) {
  const pages: PdfPage[] = [];
  const isClientInvoice =
    !invoice.shipment_id &&
    !invoice.sub_shipment_id &&
    (invoice.invoice_type === "monthly" || invoice.invoice_type === "ad_hoc");

  const newPage = (continued = false) => {
    const page: PdfPage = { commands: [], y: 0 };
    pages.push(page);
    if (continued) {
      drawText(page, MARGIN, 790, `${invoice.invoice_number} continued`, 12, "F2");
      drawTableHeader(page, 760, isClientInvoice);
    }
    return page;
  };

  let page = newPage();
  drawCompanyHeader(page, invoice, settings);
  drawBillTo(page, invoice, 675);
  drawTableHeader(page, 610, isClientInvoice);

  const activeLines = invoice.invoice_line_items.filter((line) => !line.is_suppressed);
  for (const line of activeLines) {
    const descriptionLines = wrapText(line.description, isClientInvoice ? 58 : 48, 3);
    const rowHeight = Math.max(24, descriptionLines.length * 12 + 8);
    if (page.y - rowHeight < BOTTOM + 90) {
      page = newPage(true);
    }

    const rowTop = page.y;
    descriptionLines.forEach((description, index) => {
      drawText(page, MARGIN + 4, rowTop - index * 12, description, 8);
    });
    drawText(page, 330, rowTop, Number(line.qty).toString(), 8, "F1", "right");
    drawText(page, 410, rowTop, formatCurrency(line.unit_rate), 8, "F1", "right");
    drawText(page, isClientInvoice ? RIGHT : 488, rowTop, formatCurrency(line.amount), 8, "F1", "right");
    if (!isClientInvoice) drawText(page, RIGHT, rowTop, formatCurrency(line.vat_amount), 8, "F1", "right");
    drawLine(page, MARGIN, rowTop - rowHeight + 6, RIGHT, rowTop - rowHeight + 6);
    page.y = rowTop - rowHeight;
  }

  if (page.y < 185) page = newPage(false);
  drawTotals(page, invoice, page.y - 10, isClientInvoice);
  if (page.y < 130) page = newPage(false);
  drawPaymentDetails(page, invoice, settings, page.y - 8);

  return createPdf(pages);
}
