//
//  Just enough WebKit to typecheck SpaceForeApp.swift off a Mac.
//
//  As with the AppKit stub beside it, every declaration was copied from
//  Apple's documentation for that symbol rather than written from memory, and
//  each carries the path it came from. See AppKitStub.swift for what this can
//  and cannot tell you.
//
//  Not shipped in the app. Used only by macos/Tests/run.sh.
//

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
// `WKWebView` is an `NSView`, and `CGRect` comes from the same place.
import AppKit

/// webkit/wknavigation
open class WKNavigation: NSObject {}

/// webkit/wkwebsitedatastore
open class WKWebsiteDataStore: NSObject {
    /// webkit/wkwebsitedatastore/default()
    public class func `default`() -> WKWebsiteDataStore { WKWebsiteDataStore() }
}

/// webkit/wkwebviewconfiguration
open class WKWebViewConfiguration: NSObject {
    public override init() { super.init() }
    /// webkit/wkwebviewconfiguration/websitedatastore
    open var websiteDataStore: WKWebsiteDataStore = WKWebsiteDataStore()
}

/// webkit/wknavigationaction
open class WKNavigationAction: NSObject {
    /// webkit/wknavigationaction/request
    open var request: URLRequest { URLRequest(url: URL(string: "about:blank")!) }
}

/// webkit/wknavigationactionpolicy
public enum WKNavigationActionPolicy {
    case cancel
    case allow
    case download
}

/// webkit/wkwebview
open class WKWebView: NSView {
    /// webkit/wkwebview/init(frame:configuration:)
    public init(frame: CGRect, configuration: WKWebViewConfiguration) { super.init() }
    /// webkit/wkwebview/navigationdelegate
    weak open var navigationDelegate: WKNavigationDelegate?
    /// webkit/wkwebview/uidelegate
    weak open var uiDelegate: WKUIDelegate?
    /// webkit/wkwebview/allowsbackforwardnavigationgestures
    open var allowsBackForwardNavigationGestures: Bool = false
    /// webkit/wkwebview/load(_:)-5siv6
    @discardableResult open func load(_ request: URLRequest) -> WKNavigation? { nil }
    /// webkit/wkwebview/reload()
    @discardableResult open func reload() -> WKNavigation? { nil }
}

/// webkit/wknavigationdelegate
///
/// Every member is `optional` on Apple's platforms; that needs `@objc`, which
/// does not exist here, so default implementations stand in.
public protocol WKNavigationDelegate: AnyObject {}

extension WKNavigationDelegate {
    /// webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-2ni62
    ///
    /// Apple documents the handler as `@escaping @MainActor @Sendable`. Those
    /// two attributes describe isolation the app does not opt into — it builds
    /// in Swift 5 language mode, where the plain form is what matches — so the
    /// stub is deliberately the plain form too.
    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {}

    /// webkit/wknavigationdelegate/webview(_:didfail:witherror:)
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {}

    /// webkit/wknavigationdelegate/webview(_:didfailprovisionalnavigation:witherror:)
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {}
}

/// webkit/wkuidelegate
public protocol WKUIDelegate: AnyObject {}
