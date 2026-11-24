package cloud.stwqy.spark.core.network

import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.source
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

internal const val MAX_EXPORT_BYTES = 256L * 1024 * 1024

class SparkApiClient internal constructor(
    private val origin: HttpUrl,
    private val allowCleartext: Boolean,
) {
    constructor() : this(AppConfig.ORIGIN.toHttpUrl(), AppConfig.ALLOW_CLEARTEXT_DEV_ORIGIN)

    private val originHeader = origin.toString().removeSuffix("/")

    init {
        require(isAllowedTransport(origin) && origin.encodedPath == "/" &&
            origin.query == null && origin.fragment == null &&
            origin.username.isEmpty() && origin.password.isEmpty()) { "Invalid Spark origin" }
    }

    private val api = newClient()
    private val objectStorage = newClient()

    internal suspend fun session(snapshot: SessionSnapshot): SessionResult =
        readJson(authenticated("/auth/session", snapshot).build(), 200, maxBytes = 16 * 1024)

    suspend fun projects(account: VerifiedAccount, query: String? = null, cursor: String? = null): CatalogPage<Project> =
        readJson(catalogRequest("/projects", account, query, cursor, activeOnly = true), 200)

    suspend fun tags(account: VerifiedAccount, query: String? = null, cursor: String? = null): CatalogPage<Tag> =
        readJson(catalogRequest("/tags", account, query, cursor, activeOnly = false), 200)

    suspend fun requestUpload(account: VerifiedAccount, key: String, upload: UploadRequest): UploadGrant {
        require(isUuid(key)) { "Invalid upload idempotency key" }
        val request = withCsrf("/uploads", account)
            .header("Idempotency-Key", key)
            .post(apiJson.encodeToString(UploadRequest.serializer(), upload).toRequestBody(jsonType))
            .build()
        return readJson<UploadGrant>(request, 201).also { grant ->
            if (!isUuid(grant.id)) throw ApiError.invalidResponse()
        }
    }

    suspend fun putUpload(grant: UploadGrant, file: File, transferred: (Long) -> Unit = {}) {
        val uri = try {
            URI(grant.url)
        } catch (_: URISyntaxException) {
            throw ApiError.invalidResponse()
        }
        val url = grant.url.toHttpUrlOrNull()
        if (url == null || !isAllowedTransport(url) || grant.method != "PUT" ||
            uri.rawUserInfo != null || url.fragment != null ||
            grant.headers.keys.any { it.lowercase() in forbiddenUploadHeaders }
        ) {
            throw ApiError.invalidResponse()
        }
        val length = file.length()
        if (!file.isFile || length !in 1L..AppConfig.MAX_IMAGE_BYTES.toLong()) throw IOException("Invalid upload file")
        val body = object : RequestBody() {
            override fun isOneShot() = true
            override fun contentType() = null
            override fun contentLength() = length
            override fun writeTo(sink: BufferedSink) {
                file.source().use { source ->
                    val buffer = Buffer()
                    var sent = 0L
                    while (sent < length) {
                        val count = source.read(buffer, minOf(64 * 1024L, length - sent))
                        if (count == -1L) throw IOException("Incomplete local image")
                        sink.write(buffer, count)
                        sent += count
                        transferred(sent)
                    }
                }
            }
        }
        val request = Request.Builder().url(url).put(body).apply {
            for ((name, value) in grant.headers) {
                if (!headerName.matches(name) || !validHeader(value, 8192)) throw ApiError.invalidResponse()
                header(name, value)
            }
        }.build()
        exchange(objectStorage, request, allowedStatus = { it == 200 || it == 201 || it == 204 }) {}
    }

    suspend fun completeUpload(account: VerifiedAccount, id: String): Upload =
        readJson<Upload>(withCsrf(resourcePath("/uploads", id) + "/complete", account).post(emptyBody).build(), 202)
            .checkedUploadId(id)

    suspend fun upload(account: VerifiedAccount, id: String): Upload =
        readJson<Upload>(authenticated(resourcePath("/uploads", id), account.snapshot).build(), 200)
            .checkedUploadId(id)

    private fun Upload.checkedUploadId(expected: String) = also {
        if (!id.equals(expected, ignoreCase = true)) throw ApiError.invalidResponse()
    }

    suspend fun createCollection(account: VerifiedAccount, payload: CollectionPayload): CollectionReceipt {
        val request = withCsrf("/collections", account)
            .header("Idempotency-Key", payload.id)
            .post(payload.json.toRequestBody(jsonType))
            .build()
        return readJson<CollectionReceipt>(request, 201).also { receipt ->
            if (!receipt.id.equals(payload.id, ignoreCase = true)) throw ApiError.invalidResponse()
        }
    }

    suspend fun collection(account: VerifiedAccount, id: String): CollectionReceipt =
        readJson<CollectionReceipt>(authenticated(resourcePath("/collections", id), account.snapshot).build(), 200)
            .also { if (!it.id.equals(id, ignoreCase = true)) throw ApiError.invalidResponse() }

    /** The stream and its writer finish before the caller can discard private staging. */
    suspend fun <T> export(
        account: VerifiedAccount,
        format: ExportFormat,
        write: (input: InputStream, contentDisposition: String?) -> T,
    ): T = coroutineScope {
        val url = endpoint("/me/export").newBuilder().addQueryParameter("format", format.wireValue).build()
        val request = withCsrf("/me/export", account).url(url).build()
        val call = api.newCall(request)
        call.timeout().timeout(300, TimeUnit.SECONDS)
        val cancelCall = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            withContext(Dispatchers.IO) {
                val response = try {
                    call.execute()
                } catch (error: IOException) {
                    throw ApiError.network(error)
                }
                response.use {
                    if (it.code != 200) throw serverError(it, isSparkResponse = true)
                    val body = it.body ?: throw ApiError.invalidResponse()
                    val type = body.contentType()
                    if (type?.type != "application" || type.subtype != "zip") throw ApiError.invalidResponse()
                    if (body.contentLength() > MAX_EXPORT_BYTES) throw ApiError.exportTooLarge()
                    try {
                        write(body.byteStream(), it.header("Content-Disposition"))
                    } catch (error: IOException) {
                        currentCoroutineContext().ensureActive()
                        throw error
                    }
                }
            }
        } finally {
            cancelCall.cancel()
        }
    }

    private fun isAllowedTransport(url: HttpUrl): Boolean =
        url.isHttps || allowCleartext && url.host in AppConfig.cleartextDevHosts

    private fun endpoint(path: String): HttpUrl =
        origin.newBuilder().encodedPath("/api/v1$path").build()

    private fun authenticated(path: String, snapshot: SessionSnapshot): Request.Builder {
        if (snapshot == SessionSnapshot.Guest) throw ApiError.signedOut()
        return Request.Builder().url(endpoint(path)).header("Accept", "application/json").apply {
            for ((name, value) in snapshot.requestHeaders) {
                if (!validHeader(value, 8192)) throw ApiError.signedOut()
                header(name, value)
            }
        }
    }

    private fun withCsrf(path: String, account: VerifiedAccount): Request.Builder {
        if (!validHeader(account.csrfToken, 1024)) throw ApiError.signedOut()
        return authenticated(path, account.snapshot)
            .header("Origin", originHeader)
            .header("X-CSRF-Token", account.csrfToken)
    }

    private fun catalogRequest(
        path: String,
        account: VerifiedAccount,
        query: String?,
        cursor: String?,
        activeOnly: Boolean,
    ): Request {
        val url = endpoint(path).newBuilder().apply {
            if (activeOnly) addQueryParameter("state", "active")
            addQueryParameter("limit", "100")
            query?.let { addQueryParameter("q", it) }
            cursor?.let { addQueryParameter("cursor", it) }
        }.build()
        return authenticated(path, account.snapshot).url(url).build()
    }

    private fun resourcePath(path: String, id: String): String {
        require(isUuid(id)) { "Invalid resource ID" }
        return "$path/$id"
    }

    private suspend inline fun <reified T> readJson(
        request: Request,
        status: Int,
        maxBytes: Int = 2 * 1024 * 1024,
    ): T = exchange(api, request, allowedStatus = { it == status }) { response ->
        try {
            apiJson.decodeFromString<T>(boundedBody(response, maxBytes))
        } catch (_: SerializationException) {
            // Parser diagnostics may contain the original session response or user data.
            throw ApiError.invalidResponse()
        } catch (error: IOException) {
            throw if (error is ApiError) error else ApiError.network(error)
        }
    }

    private suspend fun <T> exchange(
        client: OkHttpClient,
        request: Request,
        allowedStatus: (Int) -> Boolean,
        timeoutSeconds: Long = 60,
        read: (Response) -> T,
    ): T = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                continuation.resumeWithException(ApiError.network(e))
            }

            override fun onResponse(call: Call, response: Response) {
                if (!continuation.isActive) {
                    response.close()
                    return
                }
                continuation.resumeWith(runCatching {
                    response.use {
                        if (!allowedStatus(it.code)) throw serverError(it, client === api)
                        read(it)
                    }
                })
            }
        })
    }

    private fun serverError(response: Response, isSparkResponse: Boolean): ApiError {
        val detail = if (isSparkResponse) {
            try {
                apiJson.decodeFromString<ApiErrorEnvelope>(boundedBody(response, 16 * 1024)).error
            } catch (_: SerializationException) {
                null
            } catch (_: IOException) {
                null // The response status remains usable even if its body could not be read.
            }
        } else null
        val status = response.code
        return ApiError(
            status = status,
            code = detail?.code?.takeIf { errorCode.matches(it) } ?: "http_error",
            message = detail?.message?.take(500) ?: "请求失败（HTTP $status）。",
            retryAfterSeconds = retryAfterSeconds(response.header("Retry-After")),
            fromSpark = isSparkResponse,
        )
    }

    private fun boundedBody(response: Response, maxBytes: Int): String {
        val body = response.body ?: throw ApiError.invalidResponse()
        if (body.source().request(maxBytes.toLong() + 1)) throw ApiError.invalidResponse()
        return body.string()
    }

    private companion object {
        val jsonType = "application/json; charset=utf-8".toMediaType()
        val emptyBody: RequestBody = ByteArray(0).toRequestBody()
        val errorCode = Regex("[a-z0-9_]{1,64}")
        val headerName = Regex("[!#\$%&'*+.^_\u0060|~0-9a-zA-Z-]+")
        val forbiddenUploadHeaders = setOf("cookie", "cookie2", "origin", "x-csrf-token")

        fun validHeader(value: String, maxLength: Int): Boolean =
            value.isNotBlank() && value.length <= maxLength && value.all { it in ' '..'~' }

        fun newClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
