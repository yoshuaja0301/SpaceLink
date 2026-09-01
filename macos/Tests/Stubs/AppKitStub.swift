//
//  Just enough AppKit to typecheck SpaceForeApp.swift off a Mac.
//
//  Every declaration below was copied from Apple's own documentation for the
//  symbol — fetched, not remembered — so checking the app against this is a
//  check against an independent description of the API rather than against
//  itself. If a call here does not typecheck, the call is wrong.
//
//  What it CANNOT tell you:
//    * whether a symbol exists that is not declared here — anything the app
//      uses must be added, and adding it is where a wrong memory could slip
//      back in, so each one carries the documentation path it came from;
//    * anything about `#selector`, `@objc`, or the responder chain, because
//      Objective-C interop does not exist off Apple's platforms;
//    * whether the app *behaves* correctly. This is types, nothing more.
//
//  Not shipped in the app. Used only by macos/Tests/run.sh.
//

// Re-exported, because on a Mac `import AppKit` brings Foundation with it and
// the app relies on that — it never imports Foundation itself.
@_exported import Foundation
#if canImport(FoundationNetworking)
@_exported import FoundationNetworking
#endif

// MARK: - Geometry
//
// Not declared here: swift-corelibs-foundation already provides CGRect, CGSize
// and the NSRect / NSSize aliases, and a second set would be ambiguous. That
// they come from Foundation rather than AppKit is a difference from a Mac, and
// an unimportant one — the shapes are the same.

/// Stands in for the Objective-C runtime's `Selector`, which does not exist
/// here. `#selector(…)` is rewritten to `Selector("…")` before this runs.
public struct Selector {
    public init(_ name: String) {}
}

// MARK: - NSView / NSWindow
// appkit/nsview, appkit/nswindow

open class NSView: NSObject {}

open class NSWindow: NSObject {
    /// appkit/nswindow/stylemask-swift.struct
    public struct StyleMask: OptionSet {
        public let rawValue: UInt
        public init(rawValue: UInt) { self.rawValue = rawValue }
        public static var titled: StyleMask { StyleMask(rawValue: 1) }
        public static var closable: StyleMask { StyleMask(rawValue: 2) }
        public static var miniaturizable: StyleMask { StyleMask(rawValue: 4) }
        public static var resizable: StyleMask { StyleMask(rawValue: 8) }
        public static var fullSizeContentView: StyleMask { StyleMask(rawValue: 16) }
    }

    /// appkit/nswindow/backingstoretype
    public enum BackingStoreType {
        case buffered
    }

    public typealias FrameAutosaveName = String

    /// appkit/nswindow/init(contentrect:stylemask:backing:defer:)
    public init(contentRect: NSRect, styleMask style: StyleMask, backing backingStoreType: BackingStoreType, defer flag: Bool) {}

    /// appkit/nswindow/title
    open var title: String = ""
    /// appkit/nswindow/titlebarappearstransparent
    open var titlebarAppearsTransparent: Bool = false
    /// appkit/nswindow/contentview
    open var contentView: NSView?
    /// appkit/nswindow/minsize
    open var minSize: NSSize = NSSize(width: 0, height: 0)
    /// appkit/nswindow/setframeautosavename(_:)
    @discardableResult open func setFrameAutosaveName(_ name: FrameAutosaveName) -> Bool { true }
    /// appkit/nswindow/center()
    open func center() {}
    /// appkit/nswindow/makekeyandorderfront(_:)
    open func makeKeyAndOrderFront(_ sender: Any?) {}
    /// appkit/nswindow/togglefullscreen(_:)
    open func toggleFullScreen(_ sender: Any?) {}
}

// MARK: - NSApplication
// appkit/nsapplication

open class NSApplication: NSObject {
    /// appkit/nsapplication/modalresponse
    public struct ModalResponse: Equatable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        /// appkit/nsapplication/modalresponse/ok
        public static var OK: ModalResponse { ModalResponse(rawValue: 1) }
        /// appkit/nsapplication/modalresponse/alertfirstbuttonreturn
        public static var alertFirstButtonReturn: ModalResponse { ModalResponse(rawValue: 1000) }
    }

    /// appkit/nsapplication/activationpolicy-swift.enum
    public enum ActivationPolicy {
        case regular
    }

    /// appkit/nsapplication/shared
    public class var shared: NSApplication { NSApplication() }
    /// appkit/nsapplication/delegate — weak, which is why the app holds its own.
    weak open var delegate: NSApplicationDelegate?
    /// appkit/nsapplication/mainmenu
    open var mainMenu: NSMenu?
    /// appkit/nsapplication/setactivationpolicy(_:)
    @discardableResult open func setActivationPolicy(_ activationPolicy: ActivationPolicy) -> Bool { true }
    /// appkit/nsapplication/run()
    open func run() {}
    /// appkit/nsapplication/terminate(_:)
    open func terminate(_ sender: Any?) {}
    /// appkit/nsapplication/hide(_:)
    open func hide(_ sender: Any?) {}
    /// appkit/nsapplication/orderfrontstandardaboutpanel(_:)
    open func orderFrontStandardAboutPanel(_ sender: Any?) {}
    /// appkit/nsapplication/activate(ignoringotherapps:)
    open func activate(ignoringOtherApps ignoreOtherApps: Bool) {}
}

public let NSApp: NSApplication = NSApplication.shared

/// appkit/nsapplicationdelegate
///
/// Every member is `optional` on Apple's platforms. That needs `@objc`, which
/// does not exist here, so the same effect comes from default implementations.
public protocol NSApplicationDelegate: AnyObject {}

extension NSApplicationDelegate {
    /// appkit/nsapplicationdelegate/applicationdidfinishlaunching(_:)
    public func applicationDidFinishLaunching(_ notification: Notification) {}
    /// appkit/nsapplicationdelegate/applicationwillterminate(_:)
    public func applicationWillTerminate(_ notification: Notification) {}
    /// appkit/nsapplicationdelegate/applicationshouldterminateafterlastwindowclosed(_:)
    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

// MARK: - Menus
// appkit/nsmenu, appkit/nsmenuitem

open class NSMenuItem: NSObject {
    public override init() { super.init() }
    /// appkit/nsmenuitem/separator()
    public class func separator() -> NSMenuItem { NSMenuItem() }
    /// appkit/nsmenuitem/submenu
    open var submenu: NSMenu?
}

open class NSMenu: NSObject {
    public override init() { super.init() }
    /// appkit/nsmenu/init(title:)
    public init(title: String) { super.init() }
    /// appkit/nsmenu/additem(withtitle:action:keyequivalent:)
    @discardableResult
    open func addItem(withTitle string: String, action selector: Selector?, keyEquivalent charCode: String) -> NSMenuItem {
        NSMenuItem()
    }
    /// appkit/nsmenu/additem(_:)
    open func addItem(_ newItem: NSMenuItem) {}
}

// MARK: - Panels and alerts
// appkit/nssavepanel, appkit/nsopenpanel, appkit/nsalert

open class NSButton: NSView {}

open class NSSavePanel: NSObject {
    public override init() { super.init() }
    /// appkit/nssavepanel/title
    open var title: String!
    /// appkit/nssavepanel/message
    open var message: String!
    /// appkit/nssavepanel/prompt
    open var prompt: String!
    /// appkit/nssavepanel/cancreatedirectories
    open var canCreateDirectories: Bool = false
    /// appkit/nssavepanel/directoryurl
    open var directoryURL: URL?
    /// appkit/nssavepanel/url
    open var url: URL? { nil }
    /// appkit/nssavepanel/runmodal()
    open func runModal() -> NSApplication.ModalResponse { .OK }
}

open class NSOpenPanel: NSSavePanel {
    /// appkit/nsopenpanel/canchoosefiles
    open var canChooseFiles: Bool = true
    /// appkit/nsopenpanel/canchoosedirectories
    open var canChooseDirectories: Bool = false
    /// appkit/nsopenpanel/allowsmultipleselection
    open var allowsMultipleSelection: Bool = false
}

open class NSAlert: NSObject {
    /// appkit/nsalert/style
    public enum Style {
        case warning
        case informational
        case critical
    }

    public override init() { super.init() }
    /// appkit/nsalert/alertstyle
    open var alertStyle: Style = .warning
    /// appkit/nsalert/messagetext
    open var messageText: String = ""
    /// appkit/nsalert/informativetext
    open var informativeText: String = ""
    /// appkit/nsalert/addbutton(withtitle:)
    @discardableResult open func addButton(withTitle title: String) -> NSButton { NSButton() }
    /// appkit/nsalert/runmodal()
    open func runModal() -> NSApplication.ModalResponse { .alertFirstButtonReturn }
}

// MARK: - NSWorkspace
// appkit/nsworkspace

open class NSWorkspace: NSObject {
    /// appkit/nsworkspace/shared
    public class var shared: NSWorkspace { NSWorkspace() }
    /// appkit/nsworkspace/open(_:)
    @discardableResult open func open(_ url: URL) -> Bool { true }
}
