//go:build darwin

package auth

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdlib.h>
#include <string.h>

static OSStatus sparkKeychainSet(const char *service, const char *account, const void *data, size_t len) {
	CFStringRef cfService = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
	CFStringRef cfAccount = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
	CFDataRef cfData = CFDataCreate(kCFAllocatorDefault, (const UInt8 *)data, (CFIndex)len);

	const void *queryKeys[] = { kSecClass, kSecAttrService, kSecAttrAccount };
	const void *queryVals[] = { kSecClassGenericPassword, cfService, cfAccount };
	CFDictionaryRef query = CFDictionaryCreate(kCFAllocatorDefault, queryKeys, queryVals, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	const void *addKeys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData, kSecAttrAccessible };
	const void *addVals[] = { kSecClassGenericPassword, cfService, cfAccount, cfData, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly };
	CFDictionaryRef addDict = CFDictionaryCreate(kCFAllocatorDefault, addKeys, addVals, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	OSStatus status = SecItemAdd(addDict, NULL);

	if (status == errSecDuplicateItem) {
        const void *keys[] = { kSecValueData, kSecAttrAccessible };
        const void *vals[] = { cfData, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly };
        CFDictionaryRef update = CFDictionaryCreate(NULL, keys, vals, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        status = SecItemUpdate(query, update);
        CFRelease(update);
    }
    CFRelease(addDict);
	CFRelease(query);
	CFRelease(cfData);
	CFRelease(cfAccount);
	CFRelease(cfService);
	return status;
}

static OSStatus sparkKeychainGet(const char *service, const char *account, void **outData, size_t *outLen) {
	*outData = NULL;
	*outLen = 0;

	CFStringRef cfService = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
	CFStringRef cfAccount = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);

	const void *queryKeys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData, kSecMatchLimit };
	const void *queryVals[] = { kSecClassGenericPassword, cfService, cfAccount, kCFBooleanTrue, kSecMatchLimitOne };
	CFDictionaryRef query = CFDictionaryCreate(kCFAllocatorDefault, queryKeys, queryVals, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	CFTypeRef result = NULL;
	OSStatus status = SecItemCopyMatching(query, &result);
	if (status == errSecSuccess && result != NULL && CFGetTypeID(result) == CFDataGetTypeID()) {
		CFDataRef data = (CFDataRef)result;
		CFIndex length = CFDataGetLength(data);
		if (length > 0) {
			void *buf = malloc((size_t)length);
			if (buf != NULL) {
				memcpy(buf, CFDataGetBytePtr(data), (size_t)length);
				*outData = buf;
				*outLen = (size_t)length;
			} else {
				status = errSecAllocate;
			}
		}
	}
	if (result != NULL) {
		CFRelease(result);
	}
	CFRelease(query);
	CFRelease(cfAccount);
	CFRelease(cfService);
	return status;
}

static OSStatus sparkKeychainDelete(const char *service, const char *account) {
	CFStringRef cfService = CFStringCreateWithCString(kCFAllocatorDefault, service, kCFStringEncodingUTF8);
	CFStringRef cfAccount = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);

	const void *queryKeys[] = { kSecClass, kSecAttrService, kSecAttrAccount };
	const void *queryVals[] = { kSecClassGenericPassword, cfService, cfAccount };
	CFDictionaryRef query = CFDictionaryCreate(kCFAllocatorDefault, queryKeys, queryVals, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

	OSStatus status = SecItemDelete(query);
	CFRelease(query);
	CFRelease(cfAccount);
	CFRelease(cfService);
	return status;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

const keychainAccountName = "active-desktop-session"

// KeychainStore stores the desktop session JSON in macOS Keychain (ThisDeviceOnly).
type KeychainStore struct {
	service string
	account string
}

func NewKeychainStore(service string) *KeychainStore {
	if service == "" {
		service = "com.spark.desktop.session"
	}
	return &KeychainStore{
		service: service,
		account: keychainAccountName,
	}
}

func (k *KeychainStore) Load() (StoredSession, error) {
	cService := C.CString(k.service)
	defer C.free(unsafe.Pointer(cService))
	cAccount := C.CString(k.account)
	defer C.free(unsafe.Pointer(cAccount))

	var outData unsafe.Pointer
	var outLen C.size_t
	status := C.sparkKeychainGet(cService, cAccount, &outData, &outLen)
	if status == C.errSecItemNotFound {
		return StoredSession{}, ErrNoSession
	}
	if status != C.errSecSuccess {
		return StoredSession{}, fmt.Errorf("keychain read failed: OSStatus %d", int(status))
	}
	if outData == nil || outLen == 0 {
		return StoredSession{}, ErrNoSession
	}
	defer C.free(outData)
	raw := C.GoBytes(outData, C.int(outLen))
	return unmarshalSession(raw)
}

func (k *KeychainStore) Save(session StoredSession) error {
	raw, err := marshalSession(session)
	if err != nil {
		return err
	}
	cService := C.CString(k.service)
	defer C.free(unsafe.Pointer(cService))
	cAccount := C.CString(k.account)
	defer C.free(unsafe.Pointer(cAccount))

	status := C.sparkKeychainSet(cService, cAccount, unsafe.Pointer(&raw[0]), C.size_t(len(raw)))
	if status != C.errSecSuccess {
		return fmt.Errorf("keychain write failed: OSStatus %d", int(status))
	}
	return nil
}

func (k *KeychainStore) Clear() error {
	cService := C.CString(k.service)
	defer C.free(unsafe.Pointer(cService))
	cAccount := C.CString(k.account)
	defer C.free(unsafe.Pointer(cAccount))

	status := C.sparkKeychainDelete(cService, cAccount)
	if status != C.errSecSuccess && status != C.errSecItemNotFound {
		return fmt.Errorf("keychain delete failed: OSStatus %d", int(status))
	}
	return nil
}
