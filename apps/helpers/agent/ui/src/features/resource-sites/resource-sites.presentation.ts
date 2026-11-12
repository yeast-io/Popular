export const siteNames = { mteam: 'M-Team', hdarea: 'HDArea', hdwing: 'HDWing' };
export const resourceSitePreviews = Object.values(siteNames);

export function hdareaApiAddress(baseUrl: string): string {
  try {
    return new URL('/api/v1/', baseUrl).href;
  } catch {
    return '';
  }
}
