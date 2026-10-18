// DIBANGKITKAN oleh mockup-html/tools/build-icons-phosphor.mjs dari mockup-html/tools/icon-map-phosphor.json dan
// phosphor-codepoints.json. Jangan edit manual: ubah tabel lalu jalankan ulang skrip.
import 'package:flutter/widgets.dart';

import 'duotone_icon.dart';

/// Ikon aplikasi KAPDH: satu keluarga Phosphor (redesain v2, ADR-027) dari font yang dibundel di
/// `assets/fonts/phosphor` (keluarga font PhosphorRegular, PhosphorFill, PhosphorDuotone di pubspec). Nama mengikuti
/// nama Material lama (`Icons.home_outlined` -> `KapdhIcons.homeOutlined`); varian outlined = bobot regular, varian
/// terisi = bobot fill. Ikon duotone (akhiran `Duotone`) digambar dengan [DuotoneIcon].
abstract final class KapdhIcons {
  /// Icons.account_balance_outlined -> ph:bank
  static const IconData accountBalanceOutlined = IconData(0xe0b4, fontFamily: 'PhosphorRegular');

  /// Icons.add -> ph:plus
  static const IconData add = IconData(0xe3d4, fontFamily: 'PhosphorRegular');

  /// Icons.add_a_photo_outlined -> ph:camera-plus
  static const IconData addAPhotoOutlined = IconData(0xec58, fontFamily: 'PhosphorRegular');

  /// Icons.add_photo_alternate_outlined -> ph:image-square
  static const IconData addPhotoAlternateOutlined = IconData(0xe2cc, fontFamily: 'PhosphorRegular');

  /// Icons.admin_panel_settings_outlined -> ph:user-gear
  static const IconData adminPanelSettingsOutlined = IconData(0xe4cc, fontFamily: 'PhosphorRegular');

  /// Icons.alternate_email -> ph:at
  static const IconData alternateEmail = IconData(0xe0ac, fontFamily: 'PhosphorRegular');

  /// Icons.arrow_back -> ph:arrow-left
  static const IconData arrowBack = IconData(0xe058, fontFamily: 'PhosphorRegular');

  /// Icons.arrow_downward -> ph:arrow-down
  static const IconData arrowDownward = IconData(0xe03e, fontFamily: 'PhosphorRegular');

  /// Icons.arrow_drop_down -> ph:caret-down
  static const IconData arrowDropDown = IconData(0xe136, fontFamily: 'PhosphorRegular');

  /// Icons.arrow_forward -> ph:arrow-right
  static const IconData arrowForward = IconData(0xe06c, fontFamily: 'PhosphorRegular');

  /// Icons.article_outlined -> ph:article
  static const IconData articleOutlined = IconData(0xe0a8, fontFamily: 'PhosphorRegular');

  /// Icons.attach_file -> ph:paperclip
  static const IconData attachFile = IconData(0xe39a, fontFamily: 'PhosphorRegular');

  /// Icons.autorenew -> ph:arrows-clockwise
  static const IconData autorenew = IconData(0xe094, fontFamily: 'PhosphorRegular');

  /// Icons.backup_outlined -> ph:cloud-arrow-up
  static const IconData backupOutlined = IconData(0xe1ae, fontFamily: 'PhosphorRegular');

  /// Icons.badge -> ph:identification-card-fill
  static const IconData badge = IconData(0xe2c8, fontFamily: 'PhosphorFill');

  /// Icons.badge_outlined -> ph:identification-card
  static const IconData badgeOutlined = IconData(0xe2c8, fontFamily: 'PhosphorRegular');

  /// Icons.block -> ph:prohibit
  static const IconData block = IconData(0xe3de, fontFamily: 'PhosphorRegular');

  /// Icons.brightness_high_outlined -> ph:sun
  static const IconData brightnessHighOutlined = IconData(0xe472, fontFamily: 'PhosphorRegular');

  /// Icons.broken_image_outlined -> ph:image-broken
  static const IconData brokenImageOutlined = IconData(0xe7a8, fontFamily: 'PhosphorRegular');

  /// Icons.build_outlined -> ph:wrench
  static const IconData buildOutlined = IconData(0xe5d4, fontFamily: 'PhosphorRegular');

  /// Icons.calendar_today_outlined -> ph:calendar-blank
  static const IconData calendarTodayOutlined = IconData(0xe10a, fontFamily: 'PhosphorRegular');

  /// Icons.call_outlined -> ph:phone
  static const IconData callOutlined = IconData(0xe3b8, fontFamily: 'PhosphorRegular');

  /// Icons.camera_alt_outlined -> ph:camera
  static const IconData cameraAltOutlined = IconData(0xe10e, fontFamily: 'PhosphorRegular');

  /// Icons.campaign_outlined -> ph:megaphone
  static const IconData campaignOutlined = IconData(0xe324, fontFamily: 'PhosphorRegular');

  /// Icons.cancel -> ph:x-circle-fill
  static const IconData cancel = IconData(0xe4f8, fontFamily: 'PhosphorFill');

  /// Icons.cancel_outlined -> ph:x-circle
  static const IconData cancelOutlined = IconData(0xe4f8, fontFamily: 'PhosphorRegular');

  /// Icons.card_membership_outlined -> ph:identification-badge
  static const IconData cardMembershipOutlined = IconData(0xe6f6, fontFamily: 'PhosphorRegular');

  /// Icons.chat_bubble_outline -> ph:chat-circle
  static const IconData chatBubbleOutline = IconData(0xe168, fontFamily: 'PhosphorRegular');

  /// Icons.chat_outlined -> ph:chat-text
  static const IconData chatOutlined = IconData(0xe17a, fontFamily: 'PhosphorRegular');

  /// Icons.check -> ph:check
  static const IconData check = IconData(0xe182, fontFamily: 'PhosphorRegular');

  /// Icons.check_box -> ph:check-square-fill
  static const IconData checkBox = IconData(0xe186, fontFamily: 'PhosphorFill');

  /// Icons.check_box_outline_blank -> ph:square
  static const IconData checkBoxOutlineBlank = IconData(0xe45e, fontFamily: 'PhosphorRegular');

  /// Icons.check_circle -> ph:check-circle-fill
  static const IconData checkCircle = IconData(0xe184, fontFamily: 'PhosphorFill');

  /// Icons.check_circle_outline -> ph:check-circle
  static const IconData checkCircleOutline = IconData(0xe184, fontFamily: 'PhosphorRegular');

  /// Icons.chevron_left -> ph:caret-left
  static const IconData chevronLeft = IconData(0xe138, fontFamily: 'PhosphorRegular');

  /// Icons.chevron_right -> ph:caret-right
  static const IconData chevronRight = IconData(0xe13a, fontFamily: 'PhosphorRegular');

  /// Icons.chrome_reader_mode_outlined -> ph:book-open-text
  static const IconData chromeReaderModeOutlined = IconData(0xe8f2, fontFamily: 'PhosphorRegular');

  /// Icons.close -> ph:x
  static const IconData close = IconData(0xe4f6, fontFamily: 'PhosphorRegular');

  /// Icons.cloud_off -> ph:cloud-slash
  static const IconData cloudOff = IconData(0xe1b6, fontFamily: 'PhosphorRegular');

  /// Icons.computer -> ph:desktop
  static const IconData computer = IconData(0xe560, fontFamily: 'PhosphorRegular');

  /// Icons.confirmation_number_outlined -> ph:ticket
  static const IconData confirmationNumberOutlined = IconData(0xe490, fontFamily: 'PhosphorRegular');

  /// Icons.construction -> ph:hammer
  static const IconData construction = IconData(0xe80e, fontFamily: 'PhosphorRegular');

  /// Icons.content_copy -> ph:copy
  static const IconData contentCopy = IconData(0xe1ca, fontFamily: 'PhosphorRegular');

  /// Icons.content_paste -> ph:clipboard-text
  static const IconData contentPaste = IconData(0xe198, fontFamily: 'PhosphorRegular');

  /// Icons.copy -> ph:copy
  static const IconData copy = IconData(0xe1ca, fontFamily: 'PhosphorRegular');

  /// Icons.credit_card -> ph:credit-card
  static const IconData creditCard = IconData(0xe1d2, fontFamily: 'PhosphorRegular');

  /// Icons.delete -> ph:trash-fill
  static const IconData delete = IconData(0xe4a6, fontFamily: 'PhosphorFill');

  /// Icons.delete_forever_outlined -> ph:trash
  static const IconData deleteForeverOutlined = IconData(0xe4a6, fontFamily: 'PhosphorRegular');

  /// Icons.delete_outline -> ph:trash
  static const IconData deleteOutline = IconData(0xe4a6, fontFamily: 'PhosphorRegular');

  /// Icons.description_outlined -> ph:file-text
  static const IconData descriptionOutlined = IconData(0xe23a, fontFamily: 'PhosphorRegular');

  /// Icons.devices_outlined -> ph:devices
  static const IconData devicesOutlined = IconData(0xeba4, fontFamily: 'PhosphorRegular');

  /// Icons.dns_outlined -> ph:hard-drives
  static const IconData dnsOutlined = IconData(0xe2a0, fontFamily: 'PhosphorRegular');

  /// Icons.do_not_disturb_on_outlined -> ph:minus-circle
  static const IconData doNotDisturbOnOutlined = IconData(0xe32c, fontFamily: 'PhosphorRegular');

  /// Icons.done -> ph:check
  static const IconData done = IconData(0xe182, fontFamily: 'PhosphorRegular');

  /// Icons.done_all -> ph:checks
  static const IconData doneAll = IconData(0xe53a, fontFamily: 'PhosphorRegular');

  /// Icons.download -> ph:download-simple
  static const IconData download = IconData(0xe20c, fontFamily: 'PhosphorRegular');

  /// Icons.edit -> ph:pencil-simple
  static const IconData edit = IconData(0xe3b4, fontFamily: 'PhosphorRegular');

  /// Icons.edit_note -> ph:note-pencil
  static const IconData editNote = IconData(0xe34c, fontFamily: 'PhosphorRegular');

  /// Icons.edit_outlined -> ph:pencil-simple
  static const IconData editOutlined = IconData(0xe3b4, fontFamily: 'PhosphorRegular');

  /// Icons.error -> ph:warning-circle-fill
  static const IconData error = IconData(0xe4e2, fontFamily: 'PhosphorFill');

  /// Icons.error_outline -> ph:warning-circle
  static const IconData errorOutline = IconData(0xe4e2, fontFamily: 'PhosphorRegular');

  /// Icons.event -> ph:calendar-dots-fill
  static const IconData event = IconData(0xe7b4, fontFamily: 'PhosphorFill');

  /// Icons.event_available -> ph:calendar-check-fill
  static const IconData eventAvailable = IconData(0xe712, fontFamily: 'PhosphorFill');

  /// Icons.event_available_outlined -> ph:calendar-check
  static const IconData eventAvailableOutlined = IconData(0xe712, fontFamily: 'PhosphorRegular');

  /// Icons.event_busy -> ph:calendar-x-fill
  static const IconData eventBusy = IconData(0xe10c, fontFamily: 'PhosphorFill');

  /// Icons.event_busy_outlined -> ph:calendar-x
  static const IconData eventBusyOutlined = IconData(0xe10c, fontFamily: 'PhosphorRegular');

  /// Icons.event_note -> ph:calendar-dots
  static const IconData eventNote = IconData(0xe7b4, fontFamily: 'PhosphorRegular');

  /// Icons.event_outlined -> ph:calendar-dots
  static const IconData eventOutlined = IconData(0xe7b4, fontFamily: 'PhosphorRegular');

  /// Icons.expand_less -> ph:caret-up
  static const IconData expandLess = IconData(0xe13c, fontFamily: 'PhosphorRegular');

  /// Icons.expand_more -> ph:caret-down
  static const IconData expandMore = IconData(0xe136, fontFamily: 'PhosphorRegular');

  /// Icons.facebook -> ph:facebook-logo
  static const IconData facebook = IconData(0xe226, fontFamily: 'PhosphorRegular');

  /// Icons.favorite -> ph:heart-fill
  static const IconData favorite = IconData(0xe2a8, fontFamily: 'PhosphorFill');

  /// Icons.favorite_border -> ph:heart
  static const IconData favoriteBorder = IconData(0xe2a8, fontFamily: 'PhosphorRegular');

  /// Icons.flag_outlined -> ph:flag
  static const IconData flagOutlined = IconData(0xe244, fontFamily: 'PhosphorRegular');

  /// Icons.gavel_outlined -> ph:gavel
  static const IconData gavelOutlined = IconData(0xea32, fontFamily: 'PhosphorRegular');

  /// Icons.group_add -> ph:user-plus-fill
  static const IconData groupAdd = IconData(0xe4d0, fontFamily: 'PhosphorFill');

  /// Icons.group_add_outlined -> ph:user-plus
  static const IconData groupAddOutlined = IconData(0xe4d0, fontFamily: 'PhosphorRegular');

  /// Icons.group_off -> ph:users-three
  static const IconData groupOff = IconData(0xe68e, fontFamily: 'PhosphorRegular');

  /// Icons.groups -> ph:users-three-fill
  static const IconData groups = IconData(0xe68e, fontFamily: 'PhosphorFill');

  /// Icons.groups_outlined -> ph:users-three
  static const IconData groupsOutlined = IconData(0xe68e, fontFamily: 'PhosphorRegular');

  /// Icons.help_outline -> ph:question
  static const IconData helpOutline = IconData(0xe3e8, fontFamily: 'PhosphorRegular');

  /// Icons.hide_image_outlined -> ph:image-broken
  static const IconData hideImageOutlined = IconData(0xe7a8, fontFamily: 'PhosphorRegular');

  /// Icons.history -> ph:clock-counter-clockwise
  static const IconData history = IconData(0xe1a0, fontFamily: 'PhosphorRegular');

  /// Icons.home -> ph:house-simple-fill
  static const IconData home = IconData(0xe2c6, fontFamily: 'PhosphorFill');

  /// Icons.home_outlined -> ph:house-simple
  static const IconData homeOutlined = IconData(0xe2c6, fontFamily: 'PhosphorRegular');

  /// Icons.hourglass_top -> ph:hourglass-high
  static const IconData hourglassTop = IconData(0xe2b4, fontFamily: 'PhosphorRegular');

  /// Icons.how_to_reg -> ph:user-check-fill
  static const IconData howToReg = IconData(0xeafa, fontFamily: 'PhosphorFill');

  /// Icons.how_to_reg_outlined -> ph:user-check
  static const IconData howToRegOutlined = IconData(0xeafa, fontFamily: 'PhosphorRegular');

  /// Icons.image -> ph:image
  static const IconData image = IconData(0xe2ca, fontFamily: 'PhosphorRegular');

  /// Icons.image_outlined -> ph:image
  static const IconData imageOutlined = IconData(0xe2ca, fontFamily: 'PhosphorRegular');

  /// Icons.image_search_outlined -> ph:image-square
  static const IconData imageSearchOutlined = IconData(0xe2cc, fontFamily: 'PhosphorRegular');

  /// Icons.inbox_outlined -> ph:tray
  static const IconData inboxOutlined = IconData(0xe4aa, fontFamily: 'PhosphorRegular');

  /// Icons.info -> ph:info-fill
  static const IconData info = IconData(0xe2ce, fontFamily: 'PhosphorFill');

  /// Icons.info_outline -> ph:info
  static const IconData infoOutline = IconData(0xe2ce, fontFamily: 'PhosphorRegular');

  /// Icons.inventory_2_outlined -> ph:archive
  static const IconData inventory2Outlined = IconData(0xe00c, fontFamily: 'PhosphorRegular');

  /// Icons.keyboard_arrow_down -> ph:caret-down
  static const IconData keyboardArrowDown = IconData(0xe136, fontFamily: 'PhosphorRegular');

  /// Icons.keyboard_arrow_right -> ph:caret-right
  static const IconData keyboardArrowRight = IconData(0xe13a, fontFamily: 'PhosphorRegular');

  /// Icons.keyboard_arrow_up -> ph:caret-up
  static const IconData keyboardArrowUp = IconData(0xe13c, fontFamily: 'PhosphorRegular');

  /// Icons.link_off -> ph:link-break
  static const IconData linkOff = IconData(0xe2e4, fontFamily: 'PhosphorRegular');

  /// Icons.location_city_outlined -> ph:buildings
  static const IconData locationCityOutlined = IconData(0xe102, fontFamily: 'PhosphorRegular');

  /// Icons.location_on_outlined -> ph:map-pin
  static const IconData locationOnOutlined = IconData(0xe316, fontFamily: 'PhosphorRegular');

  /// Icons.lock -> ph:lock-simple-fill
  static const IconData lock = IconData(0xe308, fontFamily: 'PhosphorFill');

  /// Icons.lock_clock_outlined -> ph:lock-key
  static const IconData lockClockOutlined = IconData(0xe2fe, fontFamily: 'PhosphorRegular');

  /// Icons.lock_open -> ph:lock-simple-open
  static const IconData lockOpen = IconData(0xe30a, fontFamily: 'PhosphorRegular');

  /// Icons.lock_outline -> ph:lock-simple
  static const IconData lockOutline = IconData(0xe308, fontFamily: 'PhosphorRegular');

  /// Icons.lock_reset -> ph:lock-key-open
  static const IconData lockReset = IconData(0xe300, fontFamily: 'PhosphorRegular');

  /// Icons.login -> ph:sign-in
  static const IconData login = IconData(0xe428, fontFamily: 'PhosphorRegular');

  /// Icons.logout -> ph:sign-out
  static const IconData logout = IconData(0xe42a, fontFamily: 'PhosphorRegular');

  /// Icons.mail -> ph:envelope-simple-fill
  static const IconData mail = IconData(0xe218, fontFamily: 'PhosphorFill');

  /// Icons.mail_outline -> ph:envelope-simple
  static const IconData mailOutline = IconData(0xe218, fontFamily: 'PhosphorRegular');

  /// Icons.manage_accounts_outlined -> ph:user-gear
  static const IconData manageAccountsOutlined = IconData(0xe4cc, fontFamily: 'PhosphorRegular');

  /// Icons.manage_search -> ph:magnifying-glass
  static const IconData manageSearch = IconData(0xe30c, fontFamily: 'PhosphorRegular');

  /// Icons.mark_email_unread_outlined -> ph:envelope-simple-open
  static const IconData markEmailUnreadOutlined = IconData(0xe21a, fontFamily: 'PhosphorRegular');

  /// Icons.more_horiz -> ph:dots-three
  static const IconData moreHoriz = IconData(0xe1fe, fontFamily: 'PhosphorRegular');

  /// Icons.more_vert -> ph:dots-three-vertical
  static const IconData moreVert = IconData(0xe208, fontFamily: 'PhosphorRegular');

  /// Icons.notifications -> ph:bell-simple-fill
  static const IconData notifications = IconData(0xe0d0, fontFamily: 'PhosphorFill');

  /// Icons.notifications_active_outlined -> ph:bell-simple-ringing
  static const IconData notificationsActiveOutlined = IconData(0xe5ea, fontFamily: 'PhosphorRegular');

  /// Icons.notifications_none -> ph:bell-simple
  static const IconData notificationsNone = IconData(0xe0d0, fontFamily: 'PhosphorRegular');

  /// Icons.notifications_off_outlined -> ph:bell-simple-slash
  static const IconData notificationsOffOutlined = IconData(0xe0d2, fontFamily: 'PhosphorRegular');

  /// Icons.notifications_outlined -> ph:bell-simple
  static const IconData notificationsOutlined = IconData(0xe0d0, fontFamily: 'PhosphorRegular');

  /// Icons.open_in_new -> ph:arrow-square-out
  static const IconData openInNew = IconData(0xe5de, fontFamily: 'PhosphorRegular');

  /// Icons.pause_circle_outline -> ph:pause-circle
  static const IconData pauseCircleOutline = IconData(0xe3a0, fontFamily: 'PhosphorRegular');

  /// Icons.payments_outlined -> ph:money
  static const IconData paymentsOutlined = IconData(0xe588, fontFamily: 'PhosphorRegular');

  /// Icons.person -> ph:user-circle-fill
  static const IconData person = IconData(0xe4c4, fontFamily: 'PhosphorFill');

  /// Icons.person_off_outlined -> ph:user-minus
  static const IconData personOffOutlined = IconData(0xe4ce, fontFamily: 'PhosphorRegular');

  /// Icons.person_outline -> ph:user-circle
  static const IconData personOutline = IconData(0xe4c4, fontFamily: 'PhosphorRegular');

  /// Icons.person_search_outlined -> ph:user-focus
  static const IconData personSearchOutlined = IconData(0xe6fc, fontFamily: 'PhosphorRegular');

  /// Icons.phone_outlined -> ph:phone
  static const IconData phoneOutlined = IconData(0xe3b8, fontFamily: 'PhosphorRegular');

  /// Icons.phonelink_lock -> ph:device-mobile
  static const IconData phonelinkLock = IconData(0xe1e0, fontFamily: 'PhosphorRegular');

  /// Icons.photo_camera_outlined -> ph:camera
  static const IconData photoCameraOutlined = IconData(0xe10e, fontFamily: 'PhosphorRegular');

  /// Icons.photo_library_outlined -> ph:images
  static const IconData photoLibraryOutlined = IconData(0xe836, fontFamily: 'PhosphorRegular');

  /// Icons.picture_as_pdf_outlined -> ph:file-pdf
  static const IconData pictureAsPdfOutlined = IconData(0xe702, fontFamily: 'PhosphorRegular');

  /// Icons.place_outlined -> ph:map-pin
  static const IconData placeOutlined = IconData(0xe316, fontFamily: 'PhosphorRegular');

  /// Icons.policy_outlined -> ph:shield-check
  static const IconData policyOutlined = IconData(0xe40c, fontFamily: 'PhosphorRegular');

  /// Icons.privacy_tip_outlined -> ph:shield-check
  static const IconData privacyTipOutlined = IconData(0xe40c, fontFamily: 'PhosphorRegular');

  /// Icons.qr_code_2 -> ph:qr-code
  static const IconData qrCode2 = IconData(0xe3e6, fontFamily: 'PhosphorRegular');

  /// Icons.qr_code_scanner -> ph:scan
  static const IconData qrCodeScanner = IconData(0xebb6, fontFamily: 'PhosphorRegular');

  /// Icons.radio_button_checked -> ph:radio-button-fill
  static const IconData radioButtonChecked = IconData(0xeb08, fontFamily: 'PhosphorFill');

  /// Icons.radio_button_unchecked -> ph:circle
  static const IconData radioButtonUnchecked = IconData(0xe18a, fontFamily: 'PhosphorRegular');

  /// Icons.receipt_long_outlined -> ph:receipt
  static const IconData receiptLongOutlined = IconData(0xe3ec, fontFamily: 'PhosphorRegular');

  /// Icons.refresh -> ph:arrow-clockwise
  static const IconData refresh = IconData(0xe036, fontFamily: 'PhosphorRegular');

  /// Icons.remove -> ph:minus
  static const IconData remove = IconData(0xe32a, fontFamily: 'PhosphorRegular');

  /// Icons.reply -> ph:arrow-bend-up-left
  static const IconData reply = IconData(0xe024, fontFamily: 'PhosphorRegular');

  /// Icons.schedule -> ph:clock
  static const IconData schedule = IconData(0xe19a, fontFamily: 'PhosphorRegular');

  /// Icons.school -> ph:graduation-cap-fill
  static const IconData school = IconData(0xe62c, fontFamily: 'PhosphorFill');

  /// Icons.school_outlined -> ph:graduation-cap
  static const IconData schoolOutlined = IconData(0xe62c, fontFamily: 'PhosphorRegular');

  /// Icons.search -> ph:magnifying-glass
  static const IconData search = IconData(0xe30c, fontFamily: 'PhosphorRegular');

  /// Icons.search_off -> ph:magnifying-glass-minus
  static const IconData searchOff = IconData(0xe30e, fontFamily: 'PhosphorRegular');

  /// Icons.send -> ph:paper-plane-right-fill
  static const IconData send = IconData(0xe396, fontFamily: 'PhosphorFill');

  /// Icons.send_outlined -> ph:paper-plane-right
  static const IconData sendOutlined = IconData(0xe396, fontFamily: 'PhosphorRegular');

  /// Icons.settings_suggest_outlined -> ph:gear-six
  static const IconData settingsSuggestOutlined = IconData(0xe272, fontFamily: 'PhosphorRegular');

  /// Icons.share -> ph:share-network
  static const IconData share = IconData(0xe408, fontFamily: 'PhosphorRegular');

  /// Icons.shield_outlined -> ph:shield
  static const IconData shieldOutlined = IconData(0xe40a, fontFamily: 'PhosphorRegular');

  /// Icons.smartphone -> ph:device-mobile
  static const IconData smartphone = IconData(0xe1e0, fontFamily: 'PhosphorRegular');

  /// Icons.speaker_notes_off_outlined -> ph:chat-slash
  static const IconData speakerNotesOffOutlined = IconData(0xe15e, fontFamily: 'PhosphorRegular');

  /// Icons.star -> ph:star-fill
  static const IconData star = IconData(0xe46a, fontFamily: 'PhosphorFill');

  /// Icons.star_border -> ph:star
  static const IconData starBorder = IconData(0xe46a, fontFamily: 'PhosphorRegular');

  /// Icons.sync -> ph:arrows-clockwise
  static const IconData sync = IconData(0xe094, fontFamily: 'PhosphorRegular');

  /// Icons.sync_problem -> ph:cloud-warning
  static const IconData syncProblem = IconData(0xea98, fontFamily: 'PhosphorRegular');

  /// Icons.system_update -> ph:arrow-circle-down
  static const IconData systemUpdate = IconData(0xe028, fontFamily: 'PhosphorRegular');

  /// Icons.timer_off_outlined -> ph:timer
  static const IconData timerOffOutlined = IconData(0xe492, fontFamily: 'PhosphorRegular');

  /// Icons.timer_outlined -> ph:timer
  static const IconData timerOutlined = IconData(0xe492, fontFamily: 'PhosphorRegular');

  /// Icons.tune -> ph:sliders-horizontal
  static const IconData tune = IconData(0xe434, fontFamily: 'PhosphorRegular');

  /// Icons.upload_file -> ph:file-arrow-up
  static const IconData uploadFile = IconData(0xe61e, fontFamily: 'PhosphorRegular');

  /// Icons.upload_file_outlined -> ph:file-arrow-up
  static const IconData uploadFileOutlined = IconData(0xe61e, fontFamily: 'PhosphorRegular');

  /// Icons.verified_user_outlined -> ph:shield-check
  static const IconData verifiedUserOutlined = IconData(0xe40c, fontFamily: 'PhosphorRegular');

  /// Icons.visibility -> ph:eye
  static const IconData visibility = IconData(0xe220, fontFamily: 'PhosphorRegular');

  /// Icons.visibility_off -> ph:eye-slash
  static const IconData visibilityOff = IconData(0xe224, fontFamily: 'PhosphorRegular');

  /// Icons.visibility_off_outlined -> ph:eye-slash
  static const IconData visibilityOffOutlined = IconData(0xe224, fontFamily: 'PhosphorRegular');

  /// Icons.visibility_outlined -> ph:eye
  static const IconData visibilityOutlined = IconData(0xe220, fontFamily: 'PhosphorRegular');

  /// Icons.warning -> ph:warning-fill
  static const IconData warning = IconData(0xe4e0, fontFamily: 'PhosphorFill');

  /// Icons.warning_amber_rounded -> ph:warning
  static const IconData warningAmberRounded = IconData(0xe4e0, fontFamily: 'PhosphorRegular');

  /// Icons.work_outline -> ph:briefcase
  static const IconData workOutline = IconData(0xe0ee, fontFamily: 'PhosphorRegular');

  /// Icons.zoom_in -> ph:magnifying-glass-plus
  static const IconData zoomIn = IconData(0xe310, fontFamily: 'PhosphorRegular');

  /// ph:identification-card-duotone
  static const DuotoneIconData identificationCardDuotone = DuotoneIconData(
    IconData(0xe2c9, fontFamily: 'PhosphorDuotone'),
    IconData(0xe2c8, fontFamily: 'PhosphorDuotone'),
  );

  /// ph:chat-circle-dots-duotone
  static const DuotoneIconData chatCircleDotsDuotone = DuotoneIconData(
    IconData(0xe16d, fontFamily: 'PhosphorDuotone'),
    IconData(0xe16c, fontFamily: 'PhosphorDuotone'),
  );

  /// ph:bell-simple-ringing-duotone
  static const DuotoneIconData bellSimpleRingingDuotone = DuotoneIconData(
    IconData(0xe5eb, fontFamily: 'PhosphorDuotone'),
    IconData(0xe5ea, fontFamily: 'PhosphorDuotone'),
  );

  /// ph:ticket-duotone
  static const DuotoneIconData ticketDuotone = DuotoneIconData(
    IconData(0xe491, fontFamily: 'PhosphorDuotone'),
    IconData(0xe490, fontFamily: 'PhosphorDuotone'),
  );

  /// ph:newspaper-clipping-duotone
  static const DuotoneIconData newspaperClippingDuotone = DuotoneIconData(
    IconData(0xe347, fontFamily: 'PhosphorDuotone'),
    IconData(0xe346, fontFamily: 'PhosphorDuotone'),
  );
}
