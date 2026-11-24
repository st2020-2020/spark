// Run AppKit's focus bridge on a private main queue without activating real windows.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <unistd.h>

extern void sparkRememberFrontApp(void);
extern void sparkRestoreFrontApp(void);
int sparkGoTrayDropText(char *s) { return 0; }
int sparkGoTrayDropFiles(char *s) { return 0; }
int sparkGoTrayDropImage(void *s, size_t n) { return 0; }
void sparkGoTrayHoverExpand(void) {}

@interface TestFrontApp : NSObject
@property BOOL activated;
@end
@implementation TestFrontApp
- (pid_t)processIdentifier { return getpid() + 1; }
- (BOOL)isTerminated { return NO; }
- (BOOL)activateFromApplication:(NSRunningApplication *)source options:(NSApplicationActivationOptions)options {
    return [self activateWithOptions:options];
}
- (BOOL)activateWithOptions:(NSApplicationActivationOptions)options {
    self.activated = NSThread.isMainThread;
    return YES;
}
@end

int main(void) {
    @autoreleasepool {
        TestFrontApp *previous = [TestFrontApp new];
        __block id front = previous;
        Method getter = class_getInstanceMethod(NSWorkspace.class, @selector(frontmostApplication));
        method_setImplementation(getter, imp_implementationWithBlock(^id(id workspace) {
            return NSThread.isMainThread ? front : nil;
        }));
        sparkRememberFrontApp();
        front = nil;
        sparkRestoreFrontApp();
        if (!previous.activated) return 1;

        previous.activated = NO;
        front = previous;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
            sparkRememberFrontApp();
            dispatch_sync(dispatch_get_main_queue(), ^{ front = nil; });
            sparkRestoreFrontApp();
            exit(previous.activated ? 0 : 2);
        });
        [[NSRunLoop mainRunLoop] run];
    }
    return 3;
}
