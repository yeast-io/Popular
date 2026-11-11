/** A transferable URL or the base64 contents of a validated torrent file. */
export type TorrentInput = string | { metainfo: string };
