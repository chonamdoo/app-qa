package qautra.fixture;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;

public final class QAutraFixtureClient implements AutoCloseable {
    private static final class PublicationPending extends Exception {}
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private final File root;
    private final String applicationId;
    private final URL endpoint;
    private final String credential;
    private final JSONObject principal;
    private final ScheduledExecutorService queue = Executors.newSingleThreadScheduledExecutor();
    private final AtomicBoolean polling = new AtomicBoolean();
    private volatile boolean closed;
    private volatile HttpsURLConnection active;
    private boolean started;
    private boolean waiting;
    private Exception failure;
    private JSONObject authorization;
    private long authorizationDeadline;
    private static final class Validated {
        final JSONObject envelope; final long deadline;
        Validated(JSONObject envelope, long deadline) { this.envelope = envelope; this.deadline = deadline; }
    }
    private JSONObject originalBootstrap;

    public QAutraFixtureClient(Context context, String clientEndpoint, String appCredential, JSONObject expectedPrincipal) throws Exception {
        if ((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) throw new SecurityException("QA debug build required");
        endpoint = new URL(clientEndpoint);
        if (!endpoint.getProtocol().equals("https") || endpoint.getHost().isEmpty() || endpoint.getUserInfo() != null || endpoint.getQuery() != null || endpoint.getRef() != null || appCredential.length() < 32 || appCredential.length() > 4096 || !appCredential.matches("[!-~]+")) throw new SecurityException("Protected HTTPS client endpoint required");
        credential = appCredential;
        if (expectedPrincipal == null) throw new SecurityException("Independent principal required");
        principal = new JSONObject(expectedPrincipal.toString());
        keys(principal, "clientAuthorityId", "principalRef", "accountRef", "tenant");
        for (String field : new String[] {"clientAuthorityId", "principalRef", "accountRef", "tenant"}) if (!principal.getString(field).matches("[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}")) throw new SecurityException("Invalid principal");
        applicationId = context.getPackageName();
        root = new File(context.getFilesDir().getCanonicalFile(), "qautra-fixture");
        if ((!root.exists() && !root.mkdir()) || !root.isDirectory() || !root.getCanonicalPath().equals(root.getAbsolutePath())) throw new SecurityException("Mailbox unavailable");
        Os.chmod(root.getPath(), 0700);
        File ready = new File(root, "ready.json");
        if (!ready.exists()) write(ready, new JSONObject().put("schema", "qautra/native-private-mailbox/v2").put("applicationId", applicationId).toString());
        JSONObject marker = new JSONObject(readPublished(ready, 1024));
        keys(marker, "schema", "applicationId");
        if (!marker.getString("schema").equals("qautra/native-private-mailbox/v2") || !marker.getString("applicationId").equals(applicationId)) throw new SecurityException("Mailbox protocol mismatch");
    }

    public static QAutraFixtureClient provisioned(Context context) throws Exception {
        JSONObject value = new JSONObject(read(new File(context.getFilesDir(), "qautra-client.json"), 16384));
        keys(value, "schema", "clientEndpoint", "appCredential", "principal");
        if (!value.getString("schema").equals("qautra/native-client-provision/v1")) throw new SecurityException("Invalid provision");
        return new QAutraFixtureClient(context, value.getString("clientEndpoint"), value.getString("appCredential"), value.getJSONObject("principal"));
    }

    private synchronized void start() {
        if (started || closed || failure != null) throw new IllegalStateException("Client already started or terminal");
        started = true;
        queue.scheduleWithFixedDelay(() -> {
            try { pollOnce(); }
            catch (Exception error) {
                synchronized (this) { failure = error; authorization = null; notifyAll(); }
                queue.shutdown();
            }
        }, 0, 50, TimeUnit.MILLISECONDS);
    }

    /** Call off the UI thread; a return is authorization, not a test verdict. */
    public void awaitAuthorization(long timeoutMs) throws Exception {
        if (timeoutMs < 50 || timeoutMs > 60000 || principal == null) throw new SecurityException("Bounded provisioned startup required");
        try {
            synchronized (this) {
                if (waiting || closed) throw new IllegalStateException("Startup already consumed");
                waiting = true;
                start();
                long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
                while (authorization == null && failure == null && !closed) {
                    long remaining = deadline - android.os.SystemClock.elapsedRealtime();
                    if (remaining <= 0) throw new java.net.SocketTimeoutException("Native authorization unavailable");
                    wait(Math.min(remaining, 50));
                }
                requireAuthorization();
            }
        } catch (Exception error) { close(); throw error; }
    }

    public synchronized void requireAuthorization() throws Exception {
        if (closed || failure != null || authorization == null) throw new SecurityException("Business startup gated");
        if (originalBootstrap == null || !equal(originalBootstrap, new JSONObject(readPublished(new File(new File(root, originalBootstrap.getJSONObject("nativeClient").getString("sessionId")), "bootstrap.json"), 16384)))) throw new SecurityException("Original bootstrap unavailable");
        if (android.os.SystemClock.elapsedRealtime() >= authorizationDeadline) throw new SecurityException("Authorization expired");
    }

    private static void keys(JSONObject value, String... expected) throws Exception {
        Set<String> actual = new HashSet<>();
        for (Iterator<String> iterator = value.keys(); iterator.hasNext();) actual.add(iterator.next());
        if (!actual.equals(new HashSet<>(Arrays.asList(expected)))) throw new SecurityException("Unexpected response schema");
    }

    private static boolean equal(Object left, Object right) throws Exception {
        if (left instanceof JSONObject && right instanceof JSONObject) {
            JSONObject a = (JSONObject) left, b = (JSONObject) right;
            if (a.length() != b.length()) return false;
            for (Iterator<String> iterator = a.keys(); iterator.hasNext();) { String key = iterator.next(); if (!b.has(key) || !equal(a.get(key), b.get(key))) return false; }
            return true;
        }
        return left != null && left.equals(right);
    }

    private static String read(File file, int maximum) throws Exception {
        FileDescriptor fd = Os.open(file.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
        try {
            StructStat before = Os.fstat(fd);
            if (!OsConstants.S_ISREG(before.st_mode) || before.st_uid != android.os.Process.myUid() || (before.st_mode & 0077) != 0 || before.st_size < 0 || before.st_size > maximum || before.st_nlink != 1) throw new SecurityException("Invalid private mailbox file");
            byte[] bytes = new byte[(int) before.st_size + 1];
            int used = 0;
            while (used < bytes.length) {
                int size = Os.read(fd, bytes, used, bytes.length - used);
                if (size == 0) break;
                if (size < 0) throw new SecurityException("Invalid mailbox read");
                used += size;
            }
            StructStat after = Os.fstat(fd);
            if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size || before.st_mtime != after.st_mtime || used != before.st_size) throw new SecurityException("Mailbox changed");
            return StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes, 0, used)).toString();
        } finally { Os.close(fd); }
    }

    private static String readPublished(File file, int maximum) throws Exception {
        File seal = new File(file.getPath() + ".committed");
        if (!seal.exists()) throw new PublicationPending();
        read(seal, 0);
        return read(file, maximum);
    }

    private static void persistFile(File claimed) throws Exception {
        FileDescriptor fd = Os.open(claimed.getPath(), OsConstants.O_RDWR | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
        try {
            StructStat info = Os.fstat(fd);
            if (!OsConstants.S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_uid != android.os.Process.myUid() || (info.st_mode & 0077) != 0) throw new SecurityException("Invalid consumed claim");
            Os.fsync(fd);
        } finally { Os.close(fd); }
        syncDirectory(claimed.getParentFile());
    }

    private static void syncDirectory(File directory) throws Exception {
        FileDescriptor fd = Os.open(directory.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
        try {
            StructStat info = Os.fstat(fd);
            if (!OsConstants.S_ISDIR(info.st_mode) || info.st_uid != android.os.Process.myUid() || (info.st_mode & 0077) != 0) throw new SecurityException("Invalid private mailbox directory");
            Os.fsync(fd);
        } finally { Os.close(fd); }
    }

    private static void write(File file, String value) throws Exception {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        FileDescriptor fd = Os.open(file.getPath(), OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600);
        try {
            int written = 0;
            while (written < bytes.length) {
                int size = Os.write(fd, bytes, written, bytes.length - written);
                if (size <= 0) throw new SecurityException("Incomplete mailbox write");
                written += size;
            }
            Os.fsync(fd);
        } finally { Os.close(fd); }
        // Android can deny hard links; publish completed bytes with a separate exclusive, empty seal.
        FileDescriptor seal = Os.open(file.getPath() + ".committed", OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600);
        try { Os.fsync(seal); } finally { Os.close(seal); }
        syncDirectory(file.getParentFile());
    }

    private Validated validate(JSONObject result, String probe, JSONObject claim, JSONObject bootstrap, long dispatched) throws Exception {
        keys(result, "schema", "payload", "mac");
        if (!result.getString("schema").equals("qautra/native-client-authenticated-response/v1") || !result.getString("mac").matches("[a-f0-9]{64}")) throw new SecurityException("Invalid authenticated response");
        byte[] payload = android.util.Base64.decode(result.getString("payload"), android.util.Base64.NO_WRAP);
        if (payload.length > 196608) throw new SecurityException("Payload limit");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(credential.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        mac.update("qautra/native-client-response/v1\n".getBytes(StandardCharsets.UTF_8));
        byte[] expected = mac.doFinal(payload), received = new byte[32];
        for (int index = 0; index < 32; index++) received[index] = (byte) Integer.parseInt(result.getString("mac").substring(index * 2, index * 2 + 2), 16);
        if (!MessageDigest.isEqual(expected, received)) throw new SecurityException("Response provenance unavailable");
        JSONObject value = new JSONObject(StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(payload)).toString());
        keys(value, "schema", "clientProbe", "claim", "witness");
        if (!value.getString("schema").equals("qautra/native-start-authorization/v1") || !value.getString("clientProbe").equals(probe) || !equal(value.getJSONObject("claim"), claim) || principal == null) throw new SecurityException("Probe mismatch");
        JSONObject envelope = value.getJSONObject("witness"), witness = envelope.getJSONObject("witness");
        keys(envelope, "witness", "signature");
        keys(witness, "schema", "challenge", "attemptId", "ownerId", "subjectSha256", "adapterSha256", "scopeSha256", "receiptSha256", "lease", "clientAuthorityId", "principalRef", "accountRef", "tenant", "conditions", "nativeClient", "observedAt", "expiresAt");
        if (!envelope.getString("signature").matches("[a-f0-9]{64}") || !witness.getString("schema").equals("qautra/project-fixture-client-witness/v1") || !equal(witness.getJSONObject("nativeClient"), bootstrap.getJSONObject("nativeClient"))) throw new SecurityException("Witness mismatch");
        for (String field : new String[] {"challenge", "receiptSha256"}) if (!witness.getString(field).equals(claim.getString(field))) throw new SecurityException("Claim mismatch");
        for (String field : new String[] {"attemptId", "ownerId", "subjectSha256", "scopeSha256", "clientAuthorityId"}) if (!witness.getString(field).equals(bootstrap.getString(field))) throw new SecurityException("Original scope mismatch");
        for (String field : new String[] {"clientAuthorityId", "principalRef", "accountRef", "tenant"}) if (!witness.getString(field).equals(principal.getString(field))) throw new SecurityException("Principal mismatch");
        String nativeSession = bootstrap.getJSONObject("nativeClient").getString("sessionId");
        if (witness.getString("principalRef").equals(nativeSession) || witness.getString("clientAuthorityId").equals(nativeSession)) throw new SecurityException("Session is not a principal");
        for (String field : new String[] {"subjectSha256", "adapterSha256", "scopeSha256", "receiptSha256", "challenge"}) if (!witness.getString(field).matches("[a-f0-9]{64}")) throw new SecurityException("Invalid digest");
        JSONObject lease = witness.getJSONObject("lease"), expectedLease = bootstrap.getJSONObject("lease"), conditions = witness.getJSONObject("conditions");
        keys(lease, "id", "generation", "fence", "expiresAt");
        for (String field : new String[] {"id", "generation", "fence"}) if (!equal(lease.get(field), expectedLease.get(field))) throw new SecurityException("Lease mismatch");
        keys(conditions, "frontendSha256", "apiSha256", "configSha256");
        for (String field : new String[] {"frontendSha256", "apiSha256", "configSha256"}) if (!conditions.getString(field).matches("[a-f0-9]{64}")) throw new SecurityException("Invalid conditions");
        Instant observed = Instant.parse(witness.getString("observedAt")), expires = Instant.parse(witness.getString("expiresAt"));
        long proofTtl = java.time.Duration.between(observed, expires).toMillis();
        long leaseTtl = java.time.Duration.between(observed, Instant.parse(lease.getString("expiresAt"))).toMillis();
        long deadline = dispatched + Math.min(proofTtl, leaseTtl);
        if (proofTtl <= 0 || proofTtl > 60000 || leaseTtl <= 0 || android.os.SystemClock.elapsedRealtime() >= deadline) throw new SecurityException("Stale authorization");
        return new Validated(envelope, deadline);
    }

    private void pollOnce() throws Exception {
        if (closed || !polling.compareAndSet(false, true)) throw new SecurityException("Client stopped or concurrent poll");
        try {
            File[] sessions = root.listFiles();
            if (sessions == null || sessions.length > 100) throw new SecurityException("Mailbox limit");
            Arrays.sort(sessions);
            for (File session : sessions) {
                if (!session.isDirectory() || !session.getName().matches("[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}") || !session.getCanonicalPath().equals(session.getAbsolutePath())) continue;
                File bootstrapFile = new File(session, "bootstrap.json");
                if (!bootstrapFile.isFile()) continue;
                JSONObject bootstrap;
                try { bootstrap = new JSONObject(readPublished(bootstrapFile, 16384)); } catch (PublicationPending pending) { continue; }
                JSONObject nativeClient = bootstrap.getJSONObject("nativeClient");
                keys(bootstrap, "kind", "nativeClient", "clientEndpoint", "mailbox", "token", "clientAuthorityId", "lease", "attemptId", "ownerId", "subjectSha256", "scopeSha256");
                keys(nativeClient, "platform", "deviceId", "applicationId", "buildSha256", "sessionId");
                if (!bootstrap.getString("kind").equals("native-private-mailbox") || !bootstrap.getString("clientEndpoint").equals(endpoint.toString()) || !nativeClient.getString("applicationId").equals(applicationId) || !nativeClient.getString("platform").equals("android") || !nativeClient.getString("sessionId").equals(session.getName()) || !nativeClient.getString("buildSha256").matches("[a-f0-9]{64}")) throw new SecurityException("Bootstrap mismatch");
                synchronized (this) {
                    if (originalBootstrap != null && !equal(originalBootstrap, bootstrap)) throw new SecurityException("Original bootstrap replacement");
                    if (originalBootstrap == null) persistFile(bootstrapFile);
                    originalBootstrap = new JSONObject(bootstrap.toString());
                }
                File[] requests = session.listFiles((dir, name) -> name.matches("[a-f0-9]{64}\\.request\\.json"));
                if (requests == null || requests.length > 10000) throw new SecurityException("Request limit");
                Arrays.sort(requests);
                for (File request : requests) {
                    File claimed = new File(session, request.getName().replace(".request.", ".claimed."));
                    if (claimed.exists()) continue;
                    String requested;
                    try { requested = readPublished(request, 16384); } catch (PublicationPending pending) { continue; }
                    write(claimed, requested);
                    Os.remove(request.getPath());
                    Os.remove(request.getPath() + ".committed");
                    syncDirectory(session);
                    JSONObject claim = new JSONObject(readPublished(claimed, 16384));
                    keys(claim, "schema", "token", "nativeClient", "challenge", "receiptSha256");
                    if (!claim.getString("schema").equals("qautra/project-fixture-native-claim/v1") || !claim.getString("token").equals(bootstrap.getString("token")) || !equal(claim.getJSONObject("nativeClient"), nativeClient) || !claim.getString("challenge").matches("[a-f0-9]{64}") || !claimed.getName().equals(claim.getString("challenge") + ".claimed.json")) throw new SecurityException("Claim mismatch");
                    byte[] nonce = new byte[32]; RANDOM.nextBytes(nonce);
                    char[] encoded = new char[nonce.length * 2];
                    for (int index = 0; index < nonce.length; index++) {
                        encoded[index * 2] = HEX[(nonce[index] & 255) >>> 4];
                        encoded[index * 2 + 1] = HEX[nonce[index] & 15];
                    }
                    String probe = new String(encoded);
                    HttpsURLConnection connection = (HttpsURLConnection) endpoint.openConnection();
                    active = connection;
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(3000);
                    connection.setReadTimeout(3000);
                    connection.setRequestMethod("POST");
                    connection.setRequestProperty("Authorization", "Bearer " + credential);
                    connection.setRequestProperty("Content-Type", "application/json");
                    connection.setRequestProperty("Connection", "close");
                    connection.setDoOutput(true);
                    byte[] body = new JSONObject().put("schema", "qautra/native-client-probe/v1").put("clientProbe", probe).put("claim", claim).toString().getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(body.length);
                    long dispatched = android.os.SystemClock.elapsedRealtime();
                    try {
                        if (closed) throw new InterruptedException("Client stopped");
                        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
                        if (connection.getResponseCode() != 200 || !"application/json".equals(connection.getContentType()) || connection.getHeaderField("Location") != null || !connection.getURL().equals(endpoint)) throw new SecurityException("Client authority refused");
                        String result;
                        try (java.io.InputStream stream = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                            byte[] buffer = new byte[4096];
                            for (int size; (size = stream.read(buffer)) != -1;) { if (closed || android.os.SystemClock.elapsedRealtime() - dispatched > 4000) throw new SecurityException("Client request deadline"); if (bytes.size() + size > 262144) throw new SecurityException("Witness limit"); bytes.write(buffer, 0, size); }
                            result = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString();
                        }
                        Validated validated = validate(new JSONObject(result), probe, claim, bootstrap, dispatched);
                        JSONObject envelope = validated.envelope;
                        synchronized (this) {
                            if (closed || failure != null || !equal(bootstrap, new JSONObject(readPublished(bootstrapFile, 16384)))) throw new SecurityException("Original bootstrap lost");
                            write(new File(session, claim.getString("challenge") + ".response.json"), envelope.toString());
                            authorizationDeadline = validated.deadline;
                            authorization = envelope.getJSONObject("witness");
                            notifyAll();
                        }
                    } finally { active = null; connection.disconnect(); }
                }
            }
        } finally { polling.set(false); }
    }

    @Override public void close() {
        closed = true;
        HttpsURLConnection connection = active;
        if (connection != null) connection.disconnect();
        queue.shutdownNow();
        synchronized (this) { authorization = null; notifyAll(); }
    }
}
