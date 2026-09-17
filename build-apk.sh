#!/usr/bin/env bash
# ============================================================
# APK builder for "ZI Medical tests"
# Developer: Zakharevich Igor, +375293371413, csl.by
# ============================================================
set -euo pipefail

export JAVA_HOME=/usr/lib/jvm/jdk-11
export ANDROID_HOME=/home/user/android-sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/30.0.3:$PATH

APP_NAME="ZI Medical tests"
APP_ID="by.csl.budzdorov"
BUILD_DIR="/home/user/apk-build"
SRC_WEB="/home/user/bud-zdorov"
OUT_APK="/home/user/BudZdorov.apk"

ANDROID_JAR="$ANDROID_HOME/platforms/android-30/android.jar"
AAPT="$ANDROID_HOME/build-tools/30.0.3/aapt"
D8="$ANDROID_HOME/build-tools/30.0.3/d8"
ZIPALIGN="$ANDROID_HOME/build-tools/30.0.3/zipalign"
APKSIGNER="$ANDROID_HOME/build-tools/30.0.3/apksigner"
# (keystore is created in step 9 at a persistent location)

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/gen/by/csl/budzdorov" \
         "$BUILD_DIR/obj" \
         "$BUILD_DIR/assets/www" \
         "$BUILD_DIR/res/values" \
         "$BUILD_DIR/res/mipmap-hdpi" \
         "$BUILD_DIR/res/mipmap-mdpi" \
         "$BUILD_DIR/res/mipmap-xhdpi" \
         "$BUILD_DIR/res/mipmap-xxhdpi" \
         "$BUILD_DIR/res/mipmap-xxxhdpi" \
         "$BUILD_DIR/res/xml"

echo "[1/9] Copy web assets..."
cp -r "$SRC_WEB"/* "$BUILD_DIR/assets/www/"
rm -f "$BUILD_DIR/assets/www/icons/icon.svg"

echo "[2/9] AndroidManifest.xml"
cat > "$BUILD_DIR/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$APP_ID"
    android:versionCode="66"
    android:versionName="1.8.48"
    android:compileSdkVersion="34"
    android:compileSdkVersionCodename="14">
  <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="30"/>
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"/>
  <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"/>
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-feature android:name="android.hardware.camera" android:required="false"/>
  <application
      android:allowBackup="true"
      android:icon="@mipmap/ic_launcher"
      android:label="$APP_NAME"
      android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar"
      android:usesCleartextTraffic="true"
      android:networkSecurityConfig="@xml/network_security_config"
      android:hardwareAccelerated="true">
    <activity android:name=".MainActivity"
              android:exported="true"
              android:configChanges="orientation|screenSize|keyboardHidden|screenLayout"
              android:launchMode="singleTask"
              android:windowSoftInputMode="adjustResize">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
        <category android:name="android.intent.category.DEFAULT"/>
      </intent-filter>
    </activity>
    <provider android:name=".SimpleFileProvider"
              android:authorities="${APP_ID}.fileprovider"
              android:exported="false"
              android:grantUriPermissions="true">
      <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
    </provider>
  </application>
</manifest>
EOF

cat > "$BUILD_DIR/res/xml/network_security_config.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors><certificates src="system"/></trust-anchors>
  </base-config>
</network-security-config>
EOF

cat > "$BUILD_DIR/res/xml/file_paths.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <external-files-path name="pictures" path="Pictures/"/>
  <external-files-path name="root" path="."/>
</paths>
EOF

echo "[3/9] Resources..."
cat > "$BUILD_DIR/res/values/strings.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="app_name">$APP_NAME</string>
</resources>
EOF
# Generate mipmaps of different sizes
convert "$SRC_WEB/icons/icon-512.png" -resize 72x72   "$BUILD_DIR/res/mipmap-hdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 48x48   "$BUILD_DIR/res/mipmap-mdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 96x96   "$BUILD_DIR/res/mipmap-xhdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 144x144 "$BUILD_DIR/res/mipmap-xxhdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 192x192 "$BUILD_DIR/res/mipmap-xxxhdpi/ic_launcher.png"

echo "[4/9] Java source..."
mkdir -p "$BUILD_DIR/src/by/csl/budzdorov"
cp /home/user/apk-build-tmp/MainActivity.java "$BUILD_DIR/src/by/csl/budzdorov/MainActivity.java"
cp /home/user/apk-build-tmp/SimpleFileProvider.java "$BUILD_DIR/src/by/csl/budzdorov/SimpleFileProvider.java"
cp /home/user/NativeStorage.java "$BUILD_DIR/src/by/csl/budzdorov/NativeStorage.java"

echo "[5/9] Compile resources with aapt..."
cd "$BUILD_DIR"
$AAPT package -f -m -J "$BUILD_DIR/gen" -M AndroidManifest.xml -S res -I "$ANDROID_JAR"

echo "[6/9] Compile Java..."
find "$BUILD_DIR/gen" -name "*.java" > "$BUILD_DIR/sources.txt"
find "$BUILD_DIR/src" -name "*.java" >> "$BUILD_DIR/sources.txt"
javac -encoding UTF-8 -source 11 -target 11 -classpath "$ANDROID_JAR" -d "$BUILD_DIR/obj" @"$BUILD_DIR/sources.txt"

echo "[7/9] Convert to dex (d8)..."
# Find android.jar is provided by aapt already, build classes.dex
D8_LIB_DEX=
$D8 --min-api 21 --output "$BUILD_DIR" $(find "$BUILD_DIR/obj" -name "*.class") --lib "$ANDROID_JAR"

echo "[8/9] Package APK..."
$AAPT package -f -M AndroidManifest.xml -S res -A assets -I "$ANDROID_JAR" -F "$BUILD_DIR/app.unsigned.apk"
cd "$BUILD_DIR"
# add classes.dex to apk
cp "$BUILD_DIR/app.unsigned.apk" "$BUILD_DIR/app.withdex.apk"
cd "$BUILD_DIR" && zip -j app.withdex.apk classes.dex >/dev/null

echo "[9/9] Align + sign..."
$ZIPALIGN -f 4 "$BUILD_DIR/app.withdex.apk" "$BUILD_DIR/app.aligned.apk"
# ---------- Persistent release keystore ----------
# One signing key, stored OUTSIDE the build dir so it survives cleanups/reinstalls
# of the build environment. All future APKs will be signed with THE SAME key,
# which allows Android to install updates without uninstalling the previous version.
KEYSTORE="/home/user/budzdorov.jks"
if [ ! -f "$KEYSTORE" ]; then
  echo "[key] Generating persistent signing key at $KEYSTORE (keep this file!)..."
  keytool -genkeypair -v \
          -keystore "$KEYSTORE" \
          -storepass bz_zdorov_2026 \
          -alias budzdorov \
          -keypass bz_zdorov_2026 \
          -keyalg RSA -keysize 2048 -validity 36500 \
          -dname "CN=Zakharevich Igor, OU=csl.by, O=CSL, L=Minsk, ST=Minsk, C=BY" >/dev/null
  echo "[key] Keystore created. DO NOT DELETE $KEYSTORE — without it future updates won't install over the old version."
fi
$APKSIGNER sign \
  --ks "$KEYSTORE" \
  --ks-key-alias budzdorov \
  --ks-pass pass:bz_zdorov_2026 \
  --key-pass pass:bz_zdorov_2026 \
  --out "$OUT_APK" \
  "$BUILD_DIR/app.aligned.apk"
# Verify signature
$APKSIGNER verify --verbose "$OUT_APK" | tail -5

echo ""
echo "✅ APK built: $OUT_APK"
ls -lh "$OUT_APK"
