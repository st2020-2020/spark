import java.net.URI
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use(::load)
}
val devOrigin = localProperties.getProperty("spark.dev.origin", "http://10.0.2.2:5173").trim().removeSuffix("/")
val devUri = URI(devOrigin)
require(
    devUri.host != null && devUri.rawUserInfo == null && devUri.rawPath.isEmpty() &&
        devUri.rawQuery == null && devUri.rawFragment == null && !devUri.rawAuthority.endsWith(":") &&
        (devUri.port == -1 || devUri.port in 1..65535) &&
        (devUri.scheme == "https" || devUri.scheme == "http" &&
            devUri.host.lowercase() in setOf("10.0.2.2", "127.0.0.1", "localhost")),
) { "spark.dev.origin must be an HTTPS origin or an HTTP origin on 10.0.2.2, 127.0.0.1 or localhost." }

android {
    namespace = "cloud.stwqy.spark"
    compileSdk = 35

    defaultConfig {
        applicationId = "cloud.stwqy.spark"
        minSdk = 24
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
    }

    flavorDimensions += "env"
    productFlavors {
        create("prod") {
            dimension = "env"
            buildConfigField("String", "SPARK_ORIGIN", "\"https://spark.stwqy.cloud\"")
            buildConfigField("boolean", "ALLOW_CLEARTEXT_DEV_ORIGIN", "false")
            manifestPlaceholders["appPackage"] = "cloud.stwqy.spark"
            manifestPlaceholders["appLabel"] = "Spark 灵光"
        }
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("String", "SPARK_ORIGIN", "\"$devOrigin\"")
            buildConfigField("boolean", "ALLOW_CLEARTEXT_DEV_ORIGIN", "true")
            manifestPlaceholders["appPackage"] = "cloud.stwqy.spark.dev"
            manifestPlaceholders["appLabel"] = "Spark Dev"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions.unitTests.isIncludeAndroidResources = true
}

kotlin { jvmToolchain(17) }

ksp {
    arg("room.schemaLocation", layout.projectDirectory.dir("schemas").asFile.path)
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.webkit)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.coil.compose)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.room.testing)
    testImplementation(libs.work.testing)
}
