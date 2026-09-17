package by.csl.budzdorov;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient.FileChooserParams;
import android.net.Uri;
import android.content.Intent;
import android.provider.MediaStore;
import android.os.Environment;
import android.content.ActivityNotFoundException;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.os.Handler;
import android.os.Looper;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import android.util.Base64;

public class MainActivity extends Activity {
    WebView web;
    ValueCallback<Uri[]> filePathCallback;
    String camPhotoPath;
    static final int FILE_CHOOSER = 1;
    static final int REQ_CAM = 101;
    static final int REQ_GAL = 102;
    static final int REQ_GAL_MULTI = 103;
    final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle b){
        super.onCreate(b);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        if(android.os.Build.VERSION.SDK_INT>=21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.addJavascriptInterface(new NativeStorage(this), "NativeStorage");
        // Direct Android bridge for camera/gallery — works even when WebView's onShowFileChooser
        // is broken on MIUI/Samsung/Huawei firmwares.
        web.addJavascriptInterface(new Object(){
            @JavascriptInterface
            public void takePhoto(){ runOnUiThread(()->startCamera()); }
            @JavascriptInterface
            public void pickPhoto(boolean multi){ runOnUiThread(()->startGallery(multi)); }
            @JavascriptInterface
            public void openUrl(String url){
                final String u = url;
                runOnUiThread(()->{
                    try{
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    }catch(ActivityNotFoundException e){ /* ignore */ }
                });
            }
        }, "AndroidBridge");

        web.setWebViewClient(new WebViewClient(){
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest r){
                v.loadUrl(r.getUrl().toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            // Legacy + modern file chooser as fallback
            public void openFileChooser(android.webkit.ValueCallback<Uri> cb, String acc, String cap){
                startGalleryFallback(cb);
            }
            public void openFileChooser(android.webkit.ValueCallback<Uri> cb, String acc){
                startGalleryFallback(cb);
            }
            public void openFileChooser(android.webkit.ValueCallback<Uri> cb){
                startGalleryFallback(cb);
            }
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p){
                if(filePathCallback!=null){ filePathCallback.onReceiveValue(null); filePathCallback=null; }
                filePathCallback = cb;
                try{
                    Intent gal = new Intent(Intent.ACTION_GET_CONTENT);
                    gal.addCategory(Intent.CATEGORY_OPENABLE);
                    gal.setType("image/*");
                    gal.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    Intent chooser = Intent.createChooser(gal, "Выберите фото");
                    Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    if(cam.resolveActivity(getPackageManager())!=null){
                        File photo = createCameraFile();
                        if(photo!=null){
                            Uri uri = SimpleFileProvider.getUriForFile(MainActivity.this, photo);
                            cam.putExtra(MediaStore.EXTRA_OUTPUT, uri);
                            cam.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                            cam.setClipData(android.content.ClipData.newUri(getContentResolver(),"photo",uri));
                            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
                        }
                    }
                    startActivityForResult(chooser, FILE_CHOOSER);
                    return true;
                }catch(Throwable t){
                    if(cb!=null) cb.onReceiveValue(null);
                    filePathCallback=null;
                    return false;
                }
            }
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request){
                if(android.os.Build.VERSION.SDK_INT>=21) request.grant(request.getResources());
            }
        });
        // Aggressive cache purge
        try{
            deleteRecursive(new File(getCacheDir(), "org.chromium.android_webview"));
            deleteRecursive(new File(getCacheDir(), "WebView"));
            deleteRecursive(new File(getDir("webview", 0), "Cache"));
            deleteRecursive(new File(getDataDir(), "app_webview"));
            if(getCacheDir().listFiles()!=null) for(File f : getCacheDir().listFiles()) deleteRecursive(f);
        }catch(Throwable t){}
        web.clearCache(true);
        web.clearHistory();
        s.setAppCacheEnabled(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setDatabaseEnabled(true);
        try{
            int vc = getPackageManager().getPackageInfo(getPackageName(),0).versionCode;
            web.loadUrl("file:///android_asset/www/index.html?v="+vc);
        }catch(Exception e){ web.loadUrl("file:///android_asset/www/index.html"); }
    }

    private ValueCallback<Uri> legacyCb;
    private void startGalleryFallback(ValueCallback<Uri> cb){
        legacyCb=cb;
        try{
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("image/*");
            startActivityForResult(Intent.createChooser(i,"Выберите фото"), REQ_GAL);
        }catch(ActivityNotFoundException e){ if(cb!=null) cb.onReceiveValue(null); legacyCb=null; }
    }

    private File createCameraFile(){
        try{
            File dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            if(dir!=null && !dir.exists()) dir.mkdirs();
            File photo = File.createTempFile("ocr_"+System.currentTimeMillis(),".jpg", dir);
            camPhotoPath = photo.getAbsolutePath();
            return photo;
        }catch(IOException e){ camPhotoPath=null; return null; }
    }

    private void startCamera(){
        try{
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            if(cam.resolveActivity(getPackageManager())==null){
                deliverErr("Камера недоступна на устройстве");
                return;
            }
            File photo = createCameraFile();
            if(photo==null){ deliverErr("Не удалось создать файл фото"); return; }
            Uri uri = SimpleFileProvider.getUriForFile(this, photo);
            cam.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            cam.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cam.setClipData(android.content.ClipData.newUri(getContentResolver(),"photo",uri));
            startActivityForResult(cam, REQ_CAM);
        }catch(ActivityNotFoundException e){ deliverErr("Камера не найдена на устройстве"); }
    }
    private void startGallery(boolean multi){
        try{
            Intent gal = new Intent(Intent.ACTION_GET_CONTENT);
            gal.addCategory(Intent.CATEGORY_OPENABLE);
            gal.setType("image/*");
            if(multi && android.os.Build.VERSION.SDK_INT>=18) gal.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);
            startActivityForResult(Intent.createChooser(gal, multi?"Выберите фото (можно несколько)":"Выберите фото"),
                multi?REQ_GAL_MULTI:REQ_GAL);
        }catch(ActivityNotFoundException e){
            try{
                Intent pick = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
                pick.setType("image/*");
                startActivityForResult(pick, multi?REQ_GAL_MULTI:REQ_GAL);
            }catch(ActivityNotFoundException e2){ deliverErr("Галерея недоступна"); }
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data){
        Uri[] results = null;
        if(res==RESULT_OK){
            if(req==REQ_CAM){
                if(camPhotoPath!=null){
                    File f = new File(camPhotoPath);
                    if(f.exists() && f.length()>0) results = new Uri[]{ SimpleFileProvider.getUriForFile(this, f) };
                    else camPhotoPath=null;
                }
            } else if(req==REQ_GAL || req==REQ_GAL_MULTI || req==FILE_CHOOSER){
                ArrayList<Uri> list = new ArrayList<>();
                if(data!=null){
                    if(data.getClipData()!=null){
                        int n = data.getClipData().getItemCount();
                        for(int i=0;i<n;i++){
                            Uri u = data.getClipData().getItemAt(i).getUri();
                            if(u!=null){ list.add(u); addPerm(u); }
                        }
                    } else if(data.getData()!=null){
                        Uri u=data.getData(); list.add(u); addPerm(u);
                    }
                }
                if(req==FILE_CHOOSER && list.isEmpty() && camPhotoPath!=null){
                    File f = new File(camPhotoPath);
                    if(f.exists()&&f.length()>0) list.add(SimpleFileProvider.getUriForFile(this,f));
                }
                if(!list.isEmpty()) results = list.toArray(new Uri[0]);
            }
        }
        // Deliver to WebView's native file chooser if active
        if(req==FILE_CHOOSER){
            if(filePathCallback!=null){ filePathCallback.onReceiveValue(results); filePathCallback=null; }
            if(legacyCb!=null){ legacyCb.onReceiveValue(results!=null && results.length>0?results[0]:null); legacyCb=null; }
            camPhotoPath=null;
            // Also feed the same files to our JS bridge (so AndroidBridge-initiated picks also work)
            if(results!=null && results.length>0) deliverToJs(results);
            super.onActivityResult(req,res,data); return;
        }
        if(req==REQ_GAL || req==REQ_GAL_MULTI){
            if(legacyCb!=null){ legacyCb.onReceiveValue(results!=null && results.length>0?results[0]:null); legacyCb=null; }
            if(results!=null && results.length>0) deliverToJs(results);
            else deliverCancel();
            super.onActivityResult(req,res,data); return;
        }
        if(req==REQ_CAM){
            if(results!=null && results.length>0) deliverToJs(results);
            else deliverCancel();
            super.onActivityResult(req,res,data); return;
        }
        super.onActivityResult(req,res,data);
    }

    private void addPerm(Uri u){
        try{
            if(android.os.Build.VERSION.SDK_INT>=19)
                getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }catch(Throwable t){ try{ grantUriPermission(getPackageName(),u,Intent.FLAG_GRANT_READ_URI_PERMISSION); }catch(Throwable t2){} }
    }

    // Convert a list of content:// URIs to base64 data URLs and pass to JS as file objects
    private void deliverToJs(final Uri[] uris){
        new Thread(()->{
            try{
                StringBuilder sb = new StringBuilder("[");
                for(int i=0;i<uris.length;i++){
                    Uri u = uris[i];
                    String name = "photo_"+System.currentTimeMillis()+"_"+i+".jpg";
                    String mime = "image/jpeg";
                    try{
                        Cursor cur = getContentResolver().query(u, null, null, null, null);
                        if(cur!=null){
                            int ni = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                            int mi = cur.getColumnIndex("mime_type");
                            if(cur.moveToFirst()){
                                if(ni>=0){ String n=cur.getString(ni); if(n!=null&&n.length()>0) name=n; }
                            }
                            cur.close();
                        }
                        String detected = getContentResolver().getType(u);
                        if(detected!=null) mime=detected;
                    }catch(Throwable t){}
                    InputStream is = getContentResolver().openInputStream(u);
                    if(is==null) continue;
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    byte[] buf = new byte[65536]; int r;
                    while((r=is.read(buf))>0) baos.write(buf,0,r);
                    is.close();
                    String b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                    if(i>0) sb.append(',');
                    sb.append("{name:").append(jsStr(name)).append(",mime:").append(jsStr(mime))
                      .append(",dataUrl:\"data:").append(mime).append(";base64,").append(b64).append("\"}");
                }
                sb.append("]");
                final String js = "if(typeof Bridge!=='undefined'&&Bridge._onFiles)try{Bridge._onFiles("+sb+");}catch(e){console.error(e);}";
                ui.post(()->web.evaluateJavascript(js,null));
            }catch(Throwable t){
                deliverErr("Ошибка чтения файла: "+t.getMessage());
            }
            camPhotoPath=null;
        }).start();
    }
    private void deliverErr(String msg){
        final String js = "if(typeof Bridge!=='undefined'&&Bridge._err)Bridge._err("+jsStr(msg)+");";
        ui.post(()->web.evaluateJavascript(js,null));
    }
    private void deliverCancel(){
        ui.post(()->web.evaluateJavascript("if(typeof Bridge!=='undefined'&&Bridge._onCancel)Bridge._onCancel();",null));
    }
    private static String jsStr(String s){
        if(s==null) return "\"\"";
        StringBuilder o = new StringBuilder("\"");
        for(int i=0;i<s.length();i++){
            char c = s.charAt(i);
            if(c=='"'||c=='\\'){ o.append('\\'); o.append(c); }
            else if(c=='\n') o.append("\\n");
            else if(c=='\r') o.append("\\r");
            else if(c=='\t') o.append("\\t");
            else if(c<32) o.append("\\u").append(String.format("%04x",(int)c));
            else o.append(c);
        }
        o.append('"');
        return o.toString();
    }

    @Override
    public void onBackPressed(){ if(web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    private static void deleteRecursive(File f){
        if(f==null||!f.exists()) return;
        if(f.isDirectory()){ File[] k=f.listFiles(); if(k!=null)for(File x:k)deleteRecursive(x); }
        f.delete();
    }
}
