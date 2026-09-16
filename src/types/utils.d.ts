declare module '../utils/generateQRCode' {
  const generateQRCode: (data: string) => Promise<string>;
  export default generateQRCode;
}

declare module '../utils/generateReceiptPDF' {
  const generateReceiptPDF: (html: string, options?: any) => Promise<Buffer>;
  export default generateReceiptPDF;
}
