import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";

// Amazon FNSKUs are 10 characters: X00… for Amazon-barcoded items, B0… when the ASIN is used.
const FNSKU_PATTERN = /\b(?:X0|B0)[0-9A-Z]{8}\b/g;

export type FnskuPageScan = {
  totalPages: number;
  /** FNSKU -> 1-based page numbers, in document order */
  pagesByFnsku: Record<string, number[]>;
  /** Pages with no readable FNSKU (scanned images, blank pages, cover sheets) */
  pagesWithoutFnsku: number[];
  /** Pages carrying more than one FNSKU (label-sheet layout) that can't be split by page */
  multiLabelPages: number[];
  /** 1-based page number -> its text, so identical labels can be told apart from serialised ones */
  textByPage: Record<number, string>;
};

// Plain FNSKU labels repeat the same barcode, so one can be reprinted as many times as needed.
// Serialised labels (Amazon Transparency) carry a different code per unit and must never be copied.
export function labelsAreIdentical(scan: FnskuPageScan, pageNumbers: number[]) {
  if (pageNumbers.length < 2) return true;
  const first = scan.textByPage[pageNumbers[0]] ?? "";
  return pageNumbers.every((pageNumber) => (scan.textByPage[pageNumber] ?? "") === first);
}

/** Repeats the available label pages until `wanted` labels are lined up (or trims to `wanted`). */
export function pageSequenceForQuantity(pageNumbers: number[], wanted: number) {
  if (wanted <= 0 || pageNumbers.length === 0) return [];
  if (wanted <= pageNumbers.length) return pageNumbers.slice(0, wanted);
  return Array.from({ length: wanted }, (_unused, index) => pageNumbers[index % pageNumbers.length]);
}

export async function scanFnskuPages(pdfBytes: Uint8Array): Promise<FnskuPageScan> {
  // pdf.js detaches the buffer it is given, so hand it a copy and keep the original for pdf-lib.
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  const totalPages = pdf.numPages;
  const pagesByFnsku: Record<string, number[]> = {};
  const pagesWithoutFnsku: number[] = [];
  const multiLabelPages: number[] = [];
  const textByPage: Record<number, string> = {};

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    // Keep text runs on separate lines: merged page text can glue the FNSKU to the product title ("X002IKQOF3Infinite…").
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join("\n")
      .toUpperCase();
    textByPage[pageNumber] = pageText;
    const codes = [...new Set(pageText.match(FNSKU_PATTERN) ?? [])];
    if (codes.length === 0) {
      pagesWithoutFnsku.push(pageNumber);
      continue;
    }
    if (codes.length > 1) multiLabelPages.push(pageNumber);
    for (const code of codes) (pagesByFnsku[code] ??= []).push(pageNumber);
  }

  return { totalPages, pagesByFnsku, pagesWithoutFnsku, multiLabelPages, textByPage };
}

export async function loadPdf(pdfBytes: Uint8Array) {
  return PDFDocument.load(pdfBytes, { ignoreEncryption: true });
}

export async function buildPdfFromPages(source: PDFDocument, pageNumbers: number[]) {
  const target = await PDFDocument.create();
  const pages = await target.copyPages(
    source,
    pageNumbers.map((pageNumber) => pageNumber - 1),
  );
  for (const page of pages) target.addPage(page);
  return target.save();
}
