import { mountDesktopApp } from "./mount.js";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("The desktop application root is missing.");

mountDesktopApp(root);
