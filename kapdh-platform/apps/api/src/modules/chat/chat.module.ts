import { Module } from "@nestjs/common";
import { ChatLifecycleModule } from "./chat-lifecycle.module.js";
import { ChatMessagesService } from "./chat-messages.service.js";
import { ChatRoomsService } from "./chat-rooms.service.js";
import { ChatController } from "./chat.controller.js";
import { ChatRealtimeHandlers } from "./chat.realtime.js";

/**
 * F-11 (ARCHITECTURE §4.1, §4.9; PRD 3.11): room direct/grup, anggota, undangan, pesan keyset, reaksi, status baca,
 * mute, serta handler Socket.IO (typing, presence) dan kebijakan akses berkas chat_image/avatar. Efek blokir (F-12)
 * dan penghapusan akun (F-14) untuk modul lain ada di ChatLifecycleModule.
 */
@Module({
  imports: [ChatLifecycleModule],
  controllers: [ChatController],
  providers: [ChatRoomsService, ChatMessagesService, ChatRealtimeHandlers],
  exports: [ChatLifecycleModule],
})
export class ChatModule {}
