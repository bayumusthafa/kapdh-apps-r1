import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_api/kapdh_api.dart';
import 'package:kapdh_mobile/features/notifications/notifications_repository.dart';
import 'package:kapdh_mobile/features/payments/payment_updates.dart';

import 'payments_fixtures.dart';

void main() {
  test('hanya notifikasi kategori pembayaran dan keanggotaan yang memicu muat ulang', () {
    expect(isPaymentUpdate(notificationOf('payment')), isTrue);
    expect(isPaymentUpdate(notificationOf('membership')), isTrue);
    expect(isPaymentUpdate(notificationOf('news', title: 'Berita baru')), isFalse);
  });

  test('F-13: petunjuk muat ulang pembayaran diturunkan dari satu sumber notification.created', () async {
    final events = StreamController<NotificationCreatedPayload>.broadcast();
    addTearDown(events.close);
    final container = ProviderContainer(
      overrides: [notificationCreatedEventsProvider.overrideWithValue(events.stream)],
    );
    addTearDown(container.dispose);
    final received = <String>[];
    final subscription = container.read(paymentUpdatesProvider).listen((payload) => received.add(payload.title));
    addTearDown(subscription.cancel);

    events
      ..add(notificationOf('payment'))
      ..add(notificationOf('news', title: 'Berita baru'))
      ..add(notificationOf('membership', title: 'KTA aktif'));
    await pumpEventQueue();

    expect(received, ['Iuran pendaftaran disetujui', 'KTA aktif']);
  });
}
