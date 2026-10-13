// Temas e serviços que o diretor/coordenador pode ligar/desligar (lista fechada).
// Proteções de segurança (malware, phishing etc.) ficam só com a TI da Sede.
export const CATEGORIES = [
  { id: "porn", label: "Conteúdo adulto" },
  { id: "gambling", label: "Apostas (bets)" },
  { id: "dating", label: "Relacionamentos / encontros" },
  { id: "social-networks", label: "Redes sociais (todas)" },
  { id: "video-streaming", label: "Streaming de vídeo" },
  { id: "games", label: "Jogos online" },
  { id: "piracy", label: "Pirataria / torrents" },
];

export const SERVICES = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "twitter", label: "X (Twitter)" },
  { id: "snapchat", label: "Snapchat" },
  { id: "discord", label: "Discord" },
  { id: "telegram", label: "Telegram" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "youtube", label: "YouTube" },
  { id: "netflix", label: "Netflix" },
  { id: "twitch", label: "Twitch" },
  { id: "roblox", label: "Roblox" },
  { id: "fortnite", label: "Fortnite" },
  { id: "minecraft", label: "Minecraft" },
];

export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
export const SERVICE_IDS = new Set(SERVICES.map((s) => s.id));

// Domínios que nenhum gestor de escola pode bloquear.
export const PROTECTED_SUFFIXES = ["nextdns.io", "pb.gov.br"];
