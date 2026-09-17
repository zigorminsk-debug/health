package by.csl.budzdorov;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import org.json.JSONException;

public class NativeStorage {
    private final SharedPreferences sp;
    public NativeStorage(Context c){
        sp = c.getSharedPreferences("budzdorov_store", Context.MODE_PRIVATE);
    }
    @JavascriptInterface
    public String getItem(String k){
        return sp.getString(k, null);
    }
    @JavascriptInterface
    public void setItem(String k, String v){
        sp.edit().putString(k,v).apply();
    }
    @JavascriptInterface
    public void removeItem(String k){
        sp.edit().remove(k).apply();
    }
}
