import s3Client from "../r2ClientV3.js";
import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import XLSX from "xlsx";

const extensionToType = {
  json: "json",
  txt: "text",
  md: "text",
  html: "text",
  htm: "text",
  yaml: "text",
  yml: "text",
  csv: "text",
  docx: "docx",
  pdf: "pdf",
  xlsx: "xlsx",
};

export async function fetchAndParseR2Docs(bucketName = "web-chatbot-docs") {
  const allTextChunks = [];
  let files;

  // 1. List all objects in the bucket (v3)
  const listResult = await s3Client.send(
    new ListObjectsV2Command({ Bucket: bucketName })
  );
  files = (listResult.Contents || []).map((obj) => obj.Key);

  for (const file of files) {
    const ext = file.split(".").pop().toLowerCase();
    const type = extensionToType[ext] || "text";

    try {
      // 2. Download the file from R2 (v3)
      const obj = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: file })
      );
      const buffer = await obj.Body.transformToByteArray();

      // 3. Parse as before
      if (type === "json") {
        const data = JSON.parse(Buffer.from(buffer).toString("utf8"));
        allTextChunks.push(`\n[${file}]\n${JSON.stringify(data, null, 2)}\n`);
      } else if (type === "text") {
        const text = Buffer.from(buffer).toString("utf8");
        allTextChunks.push(`\n[${file}]\n${text}\n`);
      } else if (type === "docx") {
        const { value } = await mammoth.extractRawText({
          buffer: Buffer.from(buffer),
        });
        allTextChunks.push(`\n[${file}]\n${value}\n`);
      } else if (type === "pdf") {
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
          .promise;
        let textContent = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => item.str).join(" ");
          textContent += pageText + "\n";
        }
        allTextChunks.push(`\n[${file}]\n${textContent}\n`);
      } else if (type === "xlsx") {
        const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
        let sheetText = "";
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          sheetText += `Sheet: ${sheetName}\n`;
          json.forEach((row) => {
            sheetText += row.join(", ") + "\n";
          });
        });
        allTextChunks.push(`\n[${file}]\n${sheetText}\n`);
      }
    } catch (err) {
      console.error(`🔥 Error parsing R2 doc ${file}:`, err.message);
    }
  }
  return allTextChunks;
}
