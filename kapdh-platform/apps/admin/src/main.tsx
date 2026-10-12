import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createAppQueryClient } from "./App";
import { createAppRouter } from "./router";
import "./styles.css";

const queryClient = createAppQueryClient();
const router = createAppRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
