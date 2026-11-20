import { createRoot } from "react-dom/client";

import { Chat } from "./chat.tsx";
import { Shell } from "./chat-ui.tsx";
import { WalletProvider } from "./wallet.tsx";
import "./globals.css";

/** `/o/<address>` is an objective's public page; everything else is the workspace. */
const objective = /^\/o\/(0s[0-9a-f]{40})\/?$/.exec(location.pathname)?.[1];

createRoot(document.getElementById("root")!).render(
  <WalletProvider>
    <Shell Chat={Chat} {...(objective ? { objective } : {})} />
  </WalletProvider>,
);
