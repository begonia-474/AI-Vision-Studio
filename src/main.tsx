import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import { applyTheme, loadTheme } from "./theme";
import "./styles/global.css";

applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
