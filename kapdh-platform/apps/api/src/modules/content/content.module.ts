import { Module } from "@nestjs/common";
import { AdminBannersController } from "./admin-banners.controller.js";
import {
  AdminManagedEventCategoriesController,
  AdminPostCategoriesController,
} from "./admin-categories.controller.js";
import { AdminContentMediaController } from "./admin-media.controller.js";
import { AdminPagesController } from "./admin-pages.controller.js";
import { AdminPostsController } from "./admin-posts.controller.js";
import { BannersService } from "./banners.service.js";
import { CategoriesService } from "./categories.service.js";
import { ContentJobsModule } from "./content-jobs.module.js";
import { ContentMediaService } from "./content-media.service.js";
import { ContentController } from "./content.controller.js";
import { FeedService } from "./feed.service.js";
import { HomeService } from "./home.service.js";
import { PagesService } from "./pages.service.js";
import { PostsService } from "./posts.service.js";
import { PublicPagesController } from "./public-pages.controller.js";

/**
 * F-08, F-15 (ARCHITECTURE §4.1): beranda, berita (feed/detail/like), banner, halaman informasi/legal berversi,
 * kategori (anggota + admin + halaman publik), unggah gambar konten, dan job content.announce (ContentJobsModule).
 * like_count dipelihara trigger database (tidak pernah ditulis layanan); HTML disanitasi server (PRD 3.8).
 */
@Module({
  imports: [ContentJobsModule],
  controllers: [
    ContentController,
    PublicPagesController,
    AdminPostsController,
    AdminBannersController,
    AdminPagesController,
    AdminPostCategoriesController,
    AdminManagedEventCategoriesController,
    AdminContentMediaController,
  ],
  providers: [
    ContentMediaService,
    CategoriesService,
    PostsService,
    FeedService,
    BannersService,
    PagesService,
    HomeService,
  ],
})
export class ContentModule {}
