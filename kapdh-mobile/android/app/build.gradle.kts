import java.util.Properties

plugins {
    id("com.android.application")
    // Plugin Flutter Gradle harus diterapkan setelah plugin Android dan Kotlin.
    id("dev.flutter.flutter-gradle-plugin")
}

// Kunci rilis dibaca dari android/key.properties (tidak di-commit; lihat .gitignore). Tanpa berkas itu APK rilis
// lokal ("flutter build apk --release", uji internal di perangkat) ditandatangani kunci debug dan TIDAK boleh
// diunggah ke toko aplikasi; build AAB rilis untuk Play ditolak oleh penjaga di bawah (docs/BUILD.md bagian 3.1).
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseKey = keystorePropertiesFile.exists()
if (hasReleaseKey) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}
// "Generate Signed Bundle / APK" Android Studio menyuntikkan kunci rilis lewat -Pandroid.injected.signing.* tanpa
// key.properties; AGP lalu menandatangani dengan kunci itu, jadi build tersebut sah dan tidak dihentikan penjaga.
val hasInjectedSigning = providers.gradleProperty("android.injected.signing.store.file").isPresent

// Penjaga AAB rilis: bila tidak ada kunci rilis (key.properties atau kunci suntikan Android Studio), setiap graf task
// yang membuat atau menandatangani AAB rilis gagal SEBELUM task apa pun berjalan, agar AAB bertanda tangan kunci debug
// tidak dibuat untuk Play. Yang dijaga: bundle*Release (bundleRelease, dipanggil "flutter build appbundle") serta task
// AGP penghasil AAB package*ReleaseBundle dan sign*ReleaseBundle, yang juga ikut di graf setiap task turunan AAB.
// APK (assemble*), build debug/profile dan workflow CI APK debug tidak terpengaruh. whenReady berjalan saat graf task
// dihitung (fase konfigurasi) dan hanya menangkap nilai sederhana, sehingga aman untuk configuration cache; keberadaan
// key.properties dan properti Gradle suntikan tercatat sebagai input konfigurasi, jadi entri cache tidak dipakai ulang
// setelah keduanya berubah.
val releaseBundleTask = Regex("^(bundle[A-Za-z0-9]*Release|(package|sign)[A-Za-z0-9]*ReleaseBundle)$")
val appProjectPath = project.path
gradle.taskGraph.whenReady {
    if (hasReleaseKey || hasInjectedSigning) return@whenReady
    val bundleTasks =
        allTasks
            .filter { task ->
                task.path.substringBeforeLast(':').ifEmpty { ":" } == appProjectPath &&
                    releaseBundleTask.matches(task.name)
            }.map { it.name }
    if (bundleTasks.isNotEmpty()) {
        throw GradleException(
            "Build AAB rilis (${bundleTasks.joinToString()}) dihentikan: android/key.properties tidak ditemukan, " +
                "sehingga bundle akan ditandatangani kunci debug dan ditolak Google Play. Siapkan kunci unggah dan " +
                "android/key.properties sesuai kapdh-mobile/docs/BUILD.md bagian 3.1, lalu ulangi build. APK rilis " +
                "untuk uji internal (flutter build apk --release) tetap dapat dibangun tanpa berkas itu.",
        )
    }
}

android {
    namespace = "id.or.kapdh.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Diwajibkan flutter_local_notifications (API java.time pada Android lama).
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // ID aplikasi tetap untuk toko aplikasi (PRD 7.2). Lingkungan staging/production dipilih lewat
        // --dart-define-from-file=config/<lingkungan>.json (ApiConfig), bukan flavor Gradle.
        applicationId = "id.or.kapdh.app"
        // Android 8.0 (API 26) minimum sesuai D7 / N-12.
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                storeFile = keystoreProperties.getProperty("storeFile")?.let { file(it) }
                storePassword = keystoreProperties.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        release {
            // Tanpa key.properties: kunci debug, hanya untuk APK uji internal (AAB ditolak penjaga di atas).
            signingConfig =
                if (hasReleaseKey) {
                    signingConfigs.getByName("release")
                } else {
                    signingConfigs.getByName("debug")
                }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

flutter {
    source = "../.."
}
