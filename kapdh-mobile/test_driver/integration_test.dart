// Driver `flutter drive` untuk integration_test/ (build profile/release, N-03 di perangkat; docs/qa/device-matrix.md).
// `reportData` uji ditulis ke build/integration_response_data.json.
import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver();
