allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
// file_picker 10.x (dikunci pubspec; naik mayor perlu ADR, PRD 7.1) masih memakai compileSdk 34 dan
// kotlinOptions.jvmTarget '1.8' tanpa compileOptions Java. Dengan AGP 9 dan dependensinya (androidx.core 1.15,
// flutter_plugin_android_lifecycle) build Android gagal di :file_picker (checkAarMetadata: compileSdk minimal 36;
// "Inconsistent JVM-target compatibility" Java 11 vs Kotlin 1.8). Sesuaikan HANYA proyek plugin itu: compileSdk
// mengikuti aplikasi dan target Java disamakan dengan target Kotlin-nya. minSdk/targetSdk aplikasi tidak berubah.
// Hapus blok ini setelah file_picker diperbarui.
subprojects {
    if (name == "file_picker") {
        afterEvaluate {
            extensions.getByName("android").withGroovyBuilder {
                setProperty("compileSdk", 36)
                getProperty("compileOptions").withGroovyBuilder {
                    setProperty("sourceCompatibility", JavaVersion.VERSION_1_8)
                    setProperty("targetCompatibility", JavaVersion.VERSION_1_8)
                }
            }
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
