import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MascotWindow } from "./windows/mascot/MascotWindow";
import { ChatWindow } from "./windows/chat/ChatWindow";
import "@fontsource-variable/outfit";
import "./styles.css";

// One frontend bundle serves both windows; the window label picks the root component.
const label = getCurrentWindow().label;
const Root = label === "chat" ? ChatWindow : MascotWindow;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
