// stand-ocr: prints the text in a picture, read on this Mac with Apple's Vision framework.
// main.js runs it on each snap after it's taken (`stand-ocr <image file>`), so the text in a
// snap is searchable and agents can read it without looking at the image. It's built by
// scripts/build-native.js with Apple's command line tools, for Apple silicon and Intel.
//
// Output: one line per row of text on the screen, top to bottom, the pieces of a row left to
// right with two spaces between them. Exits 0 with nothing printed when there's no text.

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

/** A piece of text and where it sits, in Vision's coordinates (0 to 1, origin bottom left). */
@interface Piece : NSObject
@property(nonatomic, copy) NSString *text;
@property(nonatomic) CGRect box;
@end
@implementation Piece
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: stand-ocr <image file>\n");
      return 2;
    }
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) {
      fprintf(stderr, "couldn't open the image\n");
      return 1;
    }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (!image) {
      fprintf(stderr, "couldn't read the image\n");
      return 1;
    }

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;
    if (@available(macOS 13.0, *)) request.automaticallyDetectsLanguage = YES;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    BOOL ok = [handler performRequests:@[ request ] error:&error];
    CGImageRelease(image);
    if (!ok) {
      fprintf(stderr, "%s\n", error.localizedDescription.UTF8String ?: "text recognition failed");
      return 1;
    }

    NSMutableArray<Piece *> *pieces = [NSMutableArray array];
    for (VNRecognizedTextObservation *seen in request.results ?: @[]) {
      VNRecognizedText *best = [seen topCandidates:1].firstObject;
      if (!best || best.confidence < 0.3) continue;
      NSString *text = [best.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (!text.length) continue;
      Piece *p = [Piece new];
      p.text = text;
      p.box = seen.boundingBox;
      [pieces addObject:p];
    }

    // Rows, top to bottom: a piece joins a row when their middles are within half the
    // shorter one's height of each other.
    [pieces sortUsingComparator:^NSComparisonResult(Piece *a, Piece *b) {
      CGFloat ya = CGRectGetMidY(a.box), yb = CGRectGetMidY(b.box);
      return ya > yb ? NSOrderedAscending : ya < yb ? NSOrderedDescending : NSOrderedSame;
    }];
    NSMutableArray<NSMutableArray<Piece *> *> *rows = [NSMutableArray array];
    for (Piece *p in pieces) {
      NSMutableArray<Piece *> *row = rows.lastObject;
      Piece *first = row.firstObject;
      CGFloat near = MIN(CGRectGetHeight(first.box), CGRectGetHeight(p.box)) / 2;
      if (first && fabs(CGRectGetMidY(first.box) - CGRectGetMidY(p.box)) <= near) [row addObject:p];
      else [rows addObject:[NSMutableArray arrayWithObject:p]];
    }

    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (NSMutableArray<Piece *> *row in rows) {
      [row sortUsingComparator:^NSComparisonResult(Piece *a, Piece *b) {
        CGFloat xa = CGRectGetMinX(a.box), xb = CGRectGetMinX(b.box);
        return xa < xb ? NSOrderedAscending : xa > xb ? NSOrderedDescending : NSOrderedSame;
      }];
      [lines addObject:[[row valueForKey:@"text"] componentsJoinedByString:@"  "]];
    }
    if (lines.count) printf("%s\n", [lines componentsJoinedByString:@"\n"].UTF8String);
    return 0;
  }
}
