import { NearConnector } from "@hot-labs/near-connect";
import { fromNearConnect, Near } from "near-kit";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { NETWORK } from "../shared/config.ts";
import { observeWallet } from "./submissions.ts";

interface Wallet {
  accountId: string | undefined;
  /** Signs through the connected wallet. */
  near: Near | undefined;
  connect: () => void;
  disconnect: () => void;
}

const WalletContext = createContext<Wallet | null>(null);

/**
 * End-to-end builds only (`PUBLIC_E2E=1`, inlined at build time, so the
 * check is compiled out of real builds): a test page may install a recording
 * wallet before the app loads.
 */
const testWallet = (): Pick<Wallet, "accountId" | "near"> | undefined =>
  process.env.PUBLIC_E2E === "1"
    ? (globalThis as { __EXTENTS_TEST_WALLET__?: Pick<Wallet, "accountId" | "near"> }).__EXTENTS_TEST_WALLET__
    : undefined;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [connector, setConnector] = useState<NearConnector>();
  const [accountId, setAccountId] = useState<string>();
  const [test, setTest] = useState<ReturnType<typeof testWallet>>();

  useEffect(() => {
    const t = testWallet();
    if (t) return setTest(t);
    const c = new NearConnector({ network: NETWORK });
    c.on("wallet:signIn", ({ accounts }) => setAccountId(accounts[0]?.accountId));
    c.on("wallet:signOut", () => setAccountId(undefined));
    c.getConnectedWallet()
      .then(({ accounts }) => setAccountId(accounts[0]?.accountId))
      .catch(() => {});
    setConnector(c);
    return () => c.removeAllListeners();
  }, []);

  const value = useMemo<Wallet>(
    () =>
      test
        ? { ...test, connect: () => {}, disconnect: () => {} }
        : {
            accountId,
            near: connector && accountId ? new Near({ network: NETWORK, wallet: observeWallet(fromNearConnect(connector)) }) : undefined,
            connect: () => void connector?.connect(),
            disconnect: () => void connector?.disconnect(),
          },
    [connector, accountId, test],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): Wallet {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet outside WalletProvider");
  return wallet;
}
