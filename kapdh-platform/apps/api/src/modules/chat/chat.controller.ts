import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { FastifyReply } from "fastify";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParam } from "../../core/validation/uuid-param.pipe.js";
import { ChatMessagesService } from "./chat-messages.service.js";
import { ChatRoomsService } from "./chat-rooms.service.js";

type Schemas = components["schemas"];

/**
 * Chat langsung dan grup (F-11, F-12; PRD 3.11; kontrak domains/chat.yaml). Semua operasi: sesi mobile dengan
 * effective_status verified/expiring yang tidak suspended (`x-kapdh-access` audience mobile, member_access active;
 * AC F11-6), termasuk membaca riwayat. Keanggotaan room diperiksa di layanan pada setiap baca/kirim/unggah
 * (AC F11-4). Pesan dikirim lewat HTTP dengan ack sesudah commit (AC F11-2) dan disampaikan lewat Socket.IO.
 */
@Controller("chat")
export class ChatController {
  constructor(
    private readonly roomsService: ChatRoomsService,
    private readonly messagesService: ChatMessagesService,
  ) {}

  // -------------------------------------------------------------------------------------------------------- room

  @Get("rooms")
  @Audience("mobile")
  @MemberAccess("active")
  listRooms(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Schemas["ChatRoomPage"]> {
    return this.roomsService.listRooms(auth, query);
  }

  @Post("rooms")
  @HttpCode(201)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  createGroup(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Schemas["ChatGroupCreated"]> {
    return this.roomsService.createGroup(auth, body);
  }

  /** 200 room yang sudah ada, 201 room baru (AC F11-1). */
  @Post("direct")
  @Audience("mobile")
  @MemberAccess("active")
  async openDirect(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Schemas["ChatRoom"]> {
    const { created, room } = await this.roomsService.openDirect(auth, body);
    void reply.status(created ? 201 : 200);
    return room;
  }

  @Get("rooms/:roomId")
  @Audience("mobile")
  @MemberAccess("active")
  getRoom(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
  ): Promise<Schemas["ChatRoom"]> {
    return this.roomsService.getRoom(auth, roomId);
  }

  @Patch("rooms/:roomId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  updateRoom(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["ChatRoom"]> {
    return this.roomsService.updateRoom(auth, roomId, ifMatch, body);
  }

  @Get("rooms/:roomId/members")
  @Audience("mobile")
  @MemberAccess("active")
  listMembers(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Query() query: unknown,
  ): Promise<Schemas["ChatRoomMemberPage"]> {
    return this.roomsService.listMembers(auth, roomId, query);
  }

  @Patch("rooms/:roomId/members/:userId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  updateMember(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Param("userId", UuidParam) userId: string,
    @Body() body: unknown,
  ): Promise<Schemas["ChatRoomMember"]> {
    return this.roomsService.updateMember(auth, roomId, userId, body);
  }

  @Delete("rooms/:roomId/members/:userId")
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Param("userId", UuidParam) userId: string,
  ): Promise<void> {
    await this.roomsService.removeMember(auth, roomId, userId);
  }

  @Post("rooms/:roomId/invitations")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  invite(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Body() body: unknown,
  ): Promise<Schemas["ChatInviteOutcome"]> {
    return this.roomsService.invite(auth, roomId, body);
  }

  @Get("invitations")
  @Audience("mobile")
  @MemberAccess("active")
  listInvitations(
    @CurrentAuth() auth: AuthContext,
    @Query() query: unknown,
  ): Promise<Schemas["ChatInvitationPage"]> {
    return this.roomsService.listInvitations(auth, query);
  }

  @Post("invitations/:roomId/accept")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  acceptInvitation(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
  ): Promise<Schemas["ChatRoom"]> {
    return this.roomsService.acceptInvitation(auth, roomId);
  }

  @Post("invitations/:roomId/decline")
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  async declineInvitation(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
  ): Promise<void> {
    await this.roomsService.declineInvitation(auth, roomId);
  }

  @Post("rooms/:roomId/leave")
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent()
  async leave(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.roomsService.leave(auth, roomId, body);
  }

  @Put("rooms/:roomId/mute")
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("active")
  async setMute(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.roomsService.setMute(auth, roomId, body);
  }

  // ------------------------------------------------------------------------------------------------------- pesan

  @Get("rooms/:roomId/messages")
  @Audience("mobile")
  @MemberAccess("active")
  listMessages(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Query() query: unknown,
  ): Promise<Schemas["ChatMessagePage"]> {
    return this.messagesService.list(auth, roomId, query);
  }

  /** 201 pesan baru (ack sesudah commit), 200 pengulangan client_message_id (AC F11-2). */
  @Post("rooms/:roomId/messages")
  @Audience("mobile")
  @MemberAccess("active")
  async sendMessage(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Schemas["ChatMessage"]> {
    const { status, message } = await this.messagesService.send(auth, roomId, body);
    void reply.status(status);
    return message;
  }

  @Delete("rooms/:roomId/messages/:messageId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  deleteMessage(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Param("messageId", UuidParam) messageId: string,
  ): Promise<Schemas["ChatMessage"]> {
    return this.messagesService.remove(auth, roomId, messageId);
  }

  @Put("rooms/:roomId/messages/:messageId/reactions/:emoji")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  addReaction(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Param("messageId", UuidParam) messageId: string,
    @Param("emoji") emoji: string,
  ): Promise<Schemas["ChatMessageReactions"]> {
    return this.messagesService.addReaction(auth, roomId, messageId, emoji);
  }

  @Delete("rooms/:roomId/messages/:messageId/reactions/:emoji")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  removeReaction(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Param("messageId", UuidParam) messageId: string,
    @Param("emoji") emoji: string,
  ): Promise<Schemas["ChatMessageReactions"]> {
    return this.messagesService.removeReaction(auth, roomId, messageId, emoji);
  }

  @Put("rooms/:roomId/read")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Param("roomId", UuidParam) roomId: string,
    @Body() body: unknown,
  ): Promise<Schemas["ChatReadState"]> {
    return this.messagesService.markRead(auth, roomId, body);
  }
}
