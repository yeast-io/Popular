import openaiLogo from '../../assets/integrations/openai.svg';
import hdareaLogo from '../../assets/integrations/hdarea-line.svg';
import mteamLogo from '../../assets/integrations/mteam-line.svg';
import qbittorrentLogo from '../../assets/integrations/qbittorrent.svg';
import transmissionLogo from '../../assets/integrations/transmission.svg';
import telegramLogo from '../../assets/integrations/telegram.svg';
import whatsappLogo from '../../assets/integrations/whatsapp.svg';

// SVGs: Simple Icons 13.21.0 (CC0-1.0), https://github.com/simple-icons/simple-icons/tree/13.21.0/icons
const integrationLogos = new Map<string, string>([
  ['openai', openaiLogo],
  ['mteam', mteamLogo],
  ['hdarea', hdareaLogo],
  ['qbittorrent', qbittorrentLogo],
  ['transmission', transmissionLogo],
  ['telegram', telegramLogo],
  ['whatsapp', whatsappLogo],
]);

export function getIntegrationLogo(id: string): string | undefined {
  return integrationLogos.get(id);
}
