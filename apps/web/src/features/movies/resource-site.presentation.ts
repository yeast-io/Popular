import mteamLine from '../../assets/integrations/mteam-line.svg';
import hdareaLine from '../../assets/integrations/hdarea-line.svg';

const icons = new Map([['mteam', mteamLine], ['hdarea', hdareaLine]]);

export function resourceSiteIconStyle(id: string) {
  const icon = icons.get(id);
  return icon ? { '--resource-outline': `url("${icon}")` } : undefined;
}
