import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { configureApiTransport } from "../../web/src/api-transport.js";
import "../../web/src/styles.css";
import { desktopApiTransport } from "./api-transport.js";
import { DesktopApp } from "./DesktopApp.js";
import "./styles.css";

export interface DesktopMountDependencies {
  readonly configureTransport?: (transport: typeof desktopApiTransport) => unknown;
  readonly render?: (element: ReactNode) => void;
}

export function mountDesktopApp(
  root: HTMLElement,
  dependencies: DesktopMountDependencies = {},
): void {
  const configureTransport = dependencies.configureTransport ?? configureApiTransport;
  const render = dependencies.render ?? ((element) => createRoot(root).render(element));

  // App effects may request data as soon as React mounts, so install the native bridge first.
  configureTransport(desktopApiTransport);
  render(
    <StrictMode>
      <DesktopApp />
    </StrictMode>,
  );
}
