/**
 * Base Email Template Utility
 *
 * Provides a standardized HTML layout for all product emails.
 * Uses inline styles throughout for maximum email client compatibility
 * (Gmail, Outlook, Apple Mail, Yahoo — all strip <style> tags).
 */

export interface BaseEmailOptions {
  title: string;
  previewText?: string;
  content: string;
  footerContent?: string;
  businessName?: string;
  hideLogo?: boolean;
  variant?: "default" | "editorial";
  noPadding?: boolean;
  noFooter?: boolean;
}

const COLORS = {
  primary: "#5046E5",
  background: "#ffffff",
  surface: "#ffffff",
  text: "#1e293b",
  textMuted: "#64748b",
  border: "#e2e8f0",
  footerBg: "#fafafa",
};

export const wrapInBaseEmail = (options: BaseEmailOptions): string => {
  const {
    title,
    previewText,
    content,
    footerContent,
    businessName = "Hilaq",
    hideLogo = true,
    variant = "default",
    noPadding = false,
    noFooter = false,
  } = options;

  const isEditorial = variant === "editorial";
  const serifStack = "'Georgia', 'Times New Roman', Times, serif";
  const sansStack =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const font = isEditorial ? serifStack : sansStack;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
  <title>${title}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
    a.muted { color: ${COLORS.textMuted}; text-decoration: none; }
    a.muted:hover { text-decoration: underline; }

    @media screen and (max-width: 600px) {
      .email-container { width: 100% !important; }
      .content-pad { padding: 24px 20px !important; }
      .footer-pad { padding: 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${COLORS.background}; font-family: ${font}; color: ${COLORS.text}; -webkit-font-smoothing: antialiased;">

  ${
    previewText
      ? `
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${previewText}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>`
      : ""
  }

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${COLORS.background};">
    <tr>
      <td align="center">
        <!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" align="center"><tr><td><![endif]-->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px;" class="email-container">

          ${
            !hideLogo
              ? `
          <tr>
            <td style="padding: 28px 32px 0;">
              <span style="font-family: ${font}; font-size: 17px; font-weight: 700; letter-spacing: -0.02em; color: ${COLORS.text};">
                ${businessName}
              </span>
            </td>
          </tr>`
              : ""
          }

          <tr>
            <td class="content-pad" style="padding: ${noPadding ? "0" : "28px 32px 40px"};">
              <!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td style="font-family: Arial, sans-serif;"><![endif]-->
              <div style="font-family: ${font}; font-size: 15px; line-height: 1.65; color: ${COLORS.text};">
                ${content}
              </div>
              <!--[if mso]></td></tr></table><![endif]-->
            </td>
          </tr>

          ${!noFooter ? `
          <tr>
            <td style="padding: 0 32px;">
              <div style="height: 1px; background-color: ${COLORS.border};"></div>
            </td>
          </tr>

          <tr>
            <td class="footer-pad" style="padding: 20px 32px 32px;">
              ${footerContent ? `<div style="margin-bottom: 12px;">${footerContent}</div>` : ""}
              <p style="font-family: ${font}; font-size: 12px; line-height: 1.5; color: ${COLORS.textMuted}; margin: 0;">
                &copy; ${new Date().getFullYear()} ${businessName}
              </p>
            </td>
          </tr>` : ""}

        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>

</body>
</html>`;
};
export const emailComponents = {
  /** Bulletproof button — renders in Gmail, Outlook, Apple Mail, Yahoo */
  button: (text: string, url: string) => `
    <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 20px 0;">
      <tr>
        <td align="center" style="border-radius: 100px; background-color: ${COLORS.primary};">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="50%" fillcolor="${COLORS.primary}" stroke="f">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${text}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${url}" target="_blank" style="display: inline-block; padding: 12px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 100px; background-color: ${COLORS.primary}; line-height: 1;">
            ${text}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>
  `,

  infoGroup: (label: string, value: string) => `
    <div style="margin-bottom: 16px;">
      <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: ${COLORS.textMuted}; margin-bottom: 4px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${label}</div>
      <div style="font-size: 16px; color: ${COLORS.text}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">${value}</div>
    </div>
  `,
};
