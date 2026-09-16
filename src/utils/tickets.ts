import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';

// We conditionally load puppeteer for dev and puppeteer-core + @sparticuz/chromium for prod
// to support serverless environments like Vercel.
const isProduction = process.env.NODE_ENV === 'production';
// // eslint-disable-next-line @typescript-eslint/no-var-requires
// const puppeteer = isProduction ? require('puppeteer-core') : require('puppeteer');
// // eslint-disable-next-line @typescript-eslint/no-var-requires
// const chromium = isProduction ? require('@sparticuz/chromium') : null;

export interface TicketReceiptInfo {
  eventName: string;
  ticketName: string;
  ticketPrice: number;
  address: string;
  eventDate: string;
  orderId: string;
  id?: string;
  customerName: string;
  orderDate: string;
  time: string;
  date: string;
  ticketEntryCode: string;
  qrCode: string;
  customer_email: string;
  customer_phone?: string;
  customer_gender?: string;
}

/**
 * Generate a QR code data URL for an entry code or order id.
 */
export async function generateQRCode(code: string): Promise<string> {
  try {
    const qrCodeDataUrl = await QRCode.toDataURL(code);
    return qrCodeDataUrl;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw error as Error;
  }
}

/**
 * Generate a PDF containing one page per ticket, using the HTML template in public/receipt-template.html
 * Returns the absolute path to the generated PDF file.
 */
// export async function generateReceiptPDF(listOfTickets: TicketReceiptInfo[]): Promise<string> {
//   try {
//     const templatePath = path.resolve(__dirname, '../public/receipt-template.html');
//     if (!fs.existsSync(templatePath)) {
//       throw new Error('Template file not found.');
//     }

//     const templateHtml = fs.readFileSync(templatePath, 'utf8');
//     let combinedHtml = '';

//     listOfTickets.forEach((ticket) => {
//       let html = templateHtml;
//       html = html.replace(/{{eventName}}/g, ticket.eventName);
//       html = html.replace(/{{ticketName}}/g, ticket.ticketName);
//       html = html.replace(/{{address}}/g, ticket.address);
//       html = html.replace(/{{eventDate}}/g, ticket.eventDate);
//       html = html.replace(/{{orderId}}/g, ticket.orderId);
//       html = html.replace(/{{customerName}}/g, ticket.customerName);
//       html = html.replace(/{{orderDate}}/g, ticket.orderDate);
//       html = html.replace(/{{time}}/g, ticket.time);
//       html = html.replace(/{{date}}/g, ticket.date);
//       html = html.replace(/{{ticketEntryCode}}/g, ticket.ticketEntryCode);
//       html = html.replace(/{{qrCode}}/g, ticket.qrCode);

//       combinedHtml += html + '<div style="page-break-after: always;"></div>';
//     });

//     const browser = await (isProduction
//       ? puppeteer.launch({
//           args: chromium.args,
//           defaultViewport: chromium.defaultViewport,
//           executablePath: await chromium.executablePath(),
//           headless: chromium.headless,
//           ignoreHTTPSErrors: true,
//         })
//       : puppeteer.launch());

//     const page = await browser.newPage();
//     await page.setContent(combinedHtml, { waitUntil: 'networkidle0' });

//     const pdfPath = `/tmp/receipt-${Date.now()}.pdf`;
//     await page.pdf({ path: pdfPath, format: 'A5' });
//     await browser.close();

//     return pdfPath;
//   } catch (error) {
//     console.error(
//       'Error generating receipt PDF in',
//       isProduction ? 'production' : 'development',
//       ':',
//       error
//     );
//     throw new Error('PDF generation failed');
//   }
// }
