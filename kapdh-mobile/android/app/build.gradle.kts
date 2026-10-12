import java.util.Properties

plugins {
    id("com.android.application")
    // Plugin Flutter Gradle harus diterapkan setelah plugin Android dan Kotlin.
    id("dev.flutter.flutter-gradle-plugin")
}

// Kunci rilis dibaca dari android/key.properties (tidak di-commit; lihat .gitignore). Tanpa berkas itu build rilis
// lokal ditandatangani kunci debug dan TIDAK boleh diunggah ke toko aplikasi (runbook rilis).
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
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
        if (keystorePropertiesFile.exists()) {
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
            signingConfig =
                if (keystorePropertiesFile.exists()) {
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
