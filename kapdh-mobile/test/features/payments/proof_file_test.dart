import 'package:flutter_test/flutter_test.dart';
import 'package:kapdh_mobile/features/payments/proof_file.dart';

void main() {
  const jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0];
  const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
  const webp = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37, 0, 0, 0, 0];
  const exe = [0x4D, 0x5A, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  group('N-10: jenis berkas bukti dari magic bytes', () {
    test('JPG, PNG, WebP dan PDF dikenali; berkas lain tidak', () {
      expect(detectProofKind(jpeg), ProofKind.jpeg);
      expect(detectProofKind(png), ProofKind.png);
      expect(detectProofKind(webp), ProofKind.webp);
      expect(detectProofKind(pdf), ProofKind.pdf);
      expect(detectProofKind(exe), isNull);
      expect(detectProofKind(const [0xFF]), isNull);
    });

    test('nama unggahan selalu sesuai isi (server menolak ekstensi yang menyamarkan tipe)', () {
      expect(const PickedProof(name: 'foto.png.exe', sizeBytes: 1, kind: ProofKind.png, path: '/x').uploadName,
          'bukti-transfer.png');
      expect(ProofKind.pdf.mime, 'application/pdf');
    });
  });

  group('N-10: batas ukuran bukti (gambar <= 5 MB, PDF <= 10 MB)', () {
    test('gambar tepat 5 MB diterima, lebih 1 byte ditolak', () {
      expect(checkProof(header: jpeg, sizeBytes: 5 * 1024 * 1024), isA<ProofAccepted>());
      final rejected = checkProof(header: jpeg, sizeBytes: 5 * 1024 * 1024 + 1);
      expect(rejected, isA<ProofRejected>());
      expect((rejected as ProofRejected).message, contains('Foto maksimal 5 MB'));
    });

    test('PDF tepat 10 MB diterima, lebih 1 byte ditolak', () {
      expect(checkProof(header: pdf, sizeBytes: 10 * 1024 * 1024), isA<ProofAccepted>());
      final rejected = checkProof(header: pdf, sizeBytes: 10 * 1024 * 1024 + 1);
      expect((rejected as ProofRejected).message, contains('PDF maksimal 10 MB'));
    });

    test('berkas kosong, tipe lain, atau .pdf yang isinya bukan PDF ditolak dengan tipe yang diterima', () {
      expect((checkProof(header: jpeg, sizeBytes: 0) as ProofRejected).message, contains('kosong'));
      expect(
        (checkProof(header: exe, sizeBytes: 100) as ProofRejected).message,
        'Berkas harus berupa foto JPG/PNG atau PDF.',
      );
      expect(checkProof(header: jpeg, sizeBytes: 100, expectPdf: true), isA<ProofRejected>());
      expect((checkProof(header: pdf, sizeBytes: 100, expectPdf: true) as ProofAccepted).kind, ProofKind.pdf);
    });
  });
}
