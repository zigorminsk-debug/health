package by.csl.budzdorov;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

public class SimpleFileProvider extends ContentProvider {
    private static final String AUTHORITY_SUFFIX = ".fileprovider";

    public static Uri getUriForFile(android.content.Context ctx, File f) {
        String pkg = ctx.getPackageName();
        try {
            File base = ctx.getExternalFilesDir(null);
            if (base == null) throw new FileNotFoundException("no external files dir");
            String bp = base.getCanonicalPath();
            String fp = f.getCanonicalPath();
            if (!fp.startsWith(bp)) throw new IllegalArgumentException("outside: " + fp);
            String rel = fp.substring(bp.length());
            if (rel.startsWith("/")) rel = rel.substring(1);
            return new Uri.Builder().scheme("content")
                .authority(pkg + AUTHORITY_SUFFIX)
                .encodedPath("/" + Uri.encode(rel, "/"))
                .build();
        } catch (IOException e) { throw new RuntimeException(e); }
    }

    private File resolve(Uri uri){
        try {
            String rel = Uri.decode(uri.getEncodedPath());
            if (rel == null) return null;
            if (rel.startsWith("/")) rel = rel.substring(1);
            File base = getContext().getExternalFilesDir(null);
            if (base == null) return null;
            File f = new File(base, rel);
            String rp = f.getCanonicalPath(), bp = base.getCanonicalPath();
            if (!rp.startsWith(bp)) return null;
            return f;
        } catch (IOException e){ return null; }
    }

    @Override public boolean onCreate(){ return true; }
    @Override public Uri insert(Uri u, ContentValues v){ throw new UnsupportedOperationException(); }
    @Override public int delete(Uri u,String s,String[] sa){ throw new UnsupportedOperationException(); }
    @Override public int update(Uri u,ContentValues v,String s,String[] sa){ throw new UnsupportedOperationException(); }

    @Override
    public Cursor query(Uri u, String[] proj, String sel, String[] sa, String sort){
        File f = resolve(u);
        if (f==null || !f.exists()) return null;
        String[] cols = {"_id", OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE, "mime_type"};
        MatrixCursor c = new MatrixCursor(cols);
        c.addRow(new Object[]{1L, f.getName(), f.length(), getType(u)});
        return c;
    }

    @Override
    public String getType(Uri u){
        File f = resolve(u);
        if (f == null) return "application/octet-stream";
        String name = f.getName();
        int dot = name.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = name.substring(dot+1).toLowerCase();
        String t = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return t != null ? t : "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri u, String mode) throws FileNotFoundException {
        File f = resolve(u);
        if (f == null) throw new FileNotFoundException("missing: " + u);
        int m = ParcelFileDescriptor.MODE_READ_ONLY;
        if ("w".equals(mode) || "wt".equals(mode))
            m = ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE;
        else if ("rw".equals(mode) || "rwt".equals(mode))
            m = ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE;
        return ParcelFileDescriptor.open(f, m);
    }
}
