import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, createAppQueryClient } from "./App";
import { createAppRouter } from "./router";
// Poppins di-bundel dari origin admin sendiri (bukan Google Fonts): halaman /invite dan /login/enroll tidak memuat
// sumber pihak ketiga (kontrak admin-auth, ARCHITECTURE §2 butir 3). unicode-range membuat peramban hanya mengambil
// subset yang dipakai.
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "./styles.css";

const queryClient = createAppQueryClient();
const router = createAppRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
