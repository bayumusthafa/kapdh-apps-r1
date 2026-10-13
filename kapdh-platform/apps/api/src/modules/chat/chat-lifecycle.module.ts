import { Module } from "@nestjs/common";
import { ChatLifecycleService } from "./chat-lifecycle.service.js";
import { ChatEvents } from "./chat.events.js";
import { ChatPresenter } from "./chat.presenter.js";
import { ChatWriter } from "./chat.writer.js";

/**
 * Bagian modul chat yang boleh dimuat di luar API (ARCHITECTURE §4.1, §4.8): penulis pesan sistem, event realtime
 * chat, presenter, dan ChatLifecycleService (efek blokir F-12, keputusan moderasi remove_message, pelepasan akun yang
 * dihapus F-14 / AC F11-5). Tanpa controller dan tanpa provider khusus API (API_ONLY_PROVIDERS), sehingga modul
 * moderation dan job penghapusan akun (AccountJobsModule, dimuat worker) dapat mengimpornya:
 *
 *   @Module({ imports: [ChatLifecycleModule], providers: [...] })
 *   ... constructor(private readonly chat: ChatLifecycleService) {}
 */
@Module({
  providers: [ChatPresenter, ChatEvents, ChatWriter, ChatLifecycleService],
  exports: [ChatPresenter, ChatEvents, ChatWriter, ChatLifecycleService],
})
export class ChatLifecycleModule {}
