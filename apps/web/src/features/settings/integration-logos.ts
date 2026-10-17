import openaiLogo from '../../assets/integrations/openai.svg';
import mteamLogo from '../../assets/integrations/mteam.png';
import qbittorrentLogo from '../../assets/integrations/qbittorrent.svg';
import transmissionLogo from '../../assets/integrations/transmission.svg';
import telegramLogo from '../../assets/integrations/telegram.svg';
import whatsappLogo from '../../assets/integrations/whatsapp.svg';

// SVGs: Simple Icons 13.21.0 (CC0-1.0), https://github.com/simple-icons/simple-icons/tree/13.21.0/icons
// M-Team: official favicon from https://static.m-team.cc/favicon.ico (PNG content).
const integrationLogos = new Map<string, string>([
  ['openai', openaiLogo],
  ['mteam', mteamLogo],
  ['qbittorrent', qbittorrentLogo],
  ['transmission', transmissionLogo],
  ['telegram', telegramLogo],
  ['whatsapp', whatsappLogo],
]);

export function getIntegrationLogo(id: string): string | undefined {
  return integrationLogos.get(id);
}
