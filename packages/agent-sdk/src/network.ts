/** Tachi network selection, from env. TACHI_NETWORK=regtest (default) | signet. */
export type TachiNetworkName = "regtest" | "signet";

export interface TachiNetwork {
  name: TachiNetworkName;
  /** Tachi daemon base URL. */
  daemonUrl: string;
  /** Tachi explorer (txs, VTXOs, addresses). */
  explorerUrl: string;
  /** Bitcoin L1 explorer for deposit txs; null when the chain is private (regtest). */
  l1ExplorerUrl: string | null;
  /** bech32 HRP for L1 addresses. */
  hrp: "bcrt" | "tb";
  btcRpc: { url?: string; username?: string; password?: string };
  /** Sent as X-Api-Key so this app gets its own daemon rate-limit budget. */
  apiKey?: string;
}

const strip = (u: string) => u.replace(/\/tachi_validators$/, "").replace(/\/+$/, "");

export function tachiNetwork(env: Record<string, string | undefined> = process.env): TachiNetwork {
  if (env.TACHI_NETWORK === "signet") {
    return {
      name: "signet",
      daemonUrl: strip(env.SIGNET_BTC_NODES ?? "https://rpc-signet.tachibtc.com"),
      explorerUrl: strip(env.TACHI_SIGNET_SCAN_URL ?? "https://signet.tachibtcscan.com"),
      l1ExplorerUrl: "https://mempool.space/signet",
      hrp: "tb",
      btcRpc: { url: env.SIGNET_BTC_RPC_URL, username: env.SIGNET_BTC_RPC_USERNAME, password: env.SIGNET_BTC_RPC_PASSWORD },
      apiKey: env.TACHI_DAEMON_API_KEY || undefined,
    };
  }
  return {
    name: "regtest",
    daemonUrl: strip(env.REGTEST_BTC_NODES ?? "https://rpc-regtest.tachibtc.com"),
    explorerUrl: strip(env.TACHI_REGTEST_EXPLORER_URL ?? "https://regtest.tachibtcscan.com"),
    l1ExplorerUrl: null,
    hrp: "bcrt",
    btcRpc: { url: env.PUBLIC_REGTEST_BTC_RPC_URL, username: env.REGTEST_BTC_RPC_USERNAME, password: env.REGTEST_BTC_RPC_PASSWORD },
    apiKey: env.TACHI_DAEMON_API_KEY || undefined,
  };
}
