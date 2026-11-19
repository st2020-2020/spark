package cloud.stwqy.spark;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

public final class SparkApi {
    private static final String SESSION = WebNavigation.ORIGIN + "/api/v1/auth/session";
    private static final String COLLECTIONS = WebNavigation.ORIGIN + "/api/v1/collections";
    private static final int SESSION_RESPONSE_LIMIT = 16 * 1024;

    private SparkApi() {}

    public static final class HttpError extends IOException {
        public final int status;

        HttpError(int status) {
            super("Spark HTTP " + status);
            this.status = status;
        }
    }

    /** Returns the account UUID and CSRF token for the supplied Cookie header. */
    public static String[] session(String cookie) throws IOException {
        HttpsURLConnection connection = open(SESSION, cookie);
        try {
            expectStatus(connection, 200);
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[2048];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > SESSION_RESPONSE_LIMIT) {
                        throw new IOException("Spark session response too large");
                    }
                    bytes.write(buffer, 0, count);
                }
                JSONObject result = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
                Object id = result.getJSONObject("user").opt("id");
                Object csrf = result.opt("csrf_token");
                if (!(id instanceof String) || !CollectionPayload.isUuid((String) id)
                        || !(csrf instanceof String) || !validHeader((String) csrf, 1024)) {
                    throw new IOException("Invalid Spark session response");
                }
                return new String[] {(String) id, (String) csrf};
            } catch (JSONException invalid) {
                // Parser diagnostics can contain the original session response.
                throw new IOException("Invalid Spark session response");
            }
        } finally {
            connection.disconnect();
        }
    }

    /** Retry an uncertain save with the same UUID and unchanged payload. */
    public static void save(String cookie, String csrf, String uuid, byte[] body) throws IOException {
        if (!validHeader(csrf, 1024)) {
            throw new IOException("Invalid Spark CSRF token");
        }
        HttpsURLConnection connection = open(COLLECTIONS, cookie);
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Origin", WebNavigation.ORIGIN);
            connection.setRequestProperty("X-CSRF-Token", csrf);
            connection.setRequestProperty("Idempotency-Key", uuid);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            // A replay has the original 201. Its body can contain the entire collection.
            expectStatus(connection, 201);
        } finally {
            connection.disconnect();
        }
    }

    private static HttpsURLConnection open(String endpoint, String cookie) throws IOException {
        if (!validHeader(cookie, 8192)) {
            throw new IOException("Invalid Spark cookie header");
        }
        HttpsURLConnection connection = (HttpsURLConnection) new URL(endpoint).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(20000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cookie", cookie);
        return connection;
    }

    private static boolean validHeader(String value, int maxLength) {
        if (value == null || value.length() > maxLength || value.trim().isEmpty()) {
            return false;
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < ' ' || c > '~') {
                return false;
            }
        }
        return true;
    }

    private static void expectStatus(HttpsURLConnection connection, int expected) throws IOException {
        int status = connection.getResponseCode();
        if (status != expected) {
            throw new HttpError(status);
        }
    }
}
