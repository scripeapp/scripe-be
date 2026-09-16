declare module 'qrcode';
declare module 'puppeteer';
declare module 'puppeteer-core';
declare module '@sparticuz/chromium';
declare module '../utils' {
	export function chunk<T>(array: T[], size: number): T[][];
	export function truncatePreviewWithEllipsis(text: string, charLimit?: number): string;
	export const EMAIL_TEMPLATES: Record<string, number>;
}
declare module '../utils/emailsTemplate' {
	export function postNotificationMailToSubscribers(args: any): string;
}