//
//  Just enough WebKit to typecheck SpaceLinkApp.swift off a Mac.
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
    /// webkit/wknavigationaction/shouldperformdownload — macOS 11.3+
    open var shouldPerformDownload: Bool { false }
}

/// webkit/wknavigationresponse
open class WKNavigationResponse: NSObject {
    /// webkit/wknavigationresponse/response
    open var response: URLResponse {
        // Linux Foundation has no argument-less initialiser; the shape is what matters.
        URLResponse(url: URL(string: "about:blank")!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
    }
    /// webkit/wknavigationresponse/canshowmimetype
    open var canShowMIMEType: Bool { true }
    /// webkit/wknavigationresponse/isformainframe
    open var isForMainFrame: Bool { true }
}

/// webkit/wknavigationresponsepolicy
public enum WKNavigationResponsePolicy {
    case cancel
    case allow
    case download
}

/// webkit/wkdownload — macOS 11.3+
open class WKDownload: NSObject {
    /// webkit/wkdownload/delegate
    weak open var delegate: (any WKDownloadDelegate)?
    /// webkit/wkdownload/originalrequest
    open var originalRequest: URLRequest? { nil }
    /// webkit/wkdownload/webview
    weak open var webView: WKWebView?
    /// webkit/wkdownload/cancel(_:)
    open func cancel(_ completionHandler: ((Data?) -> Void)?) {}
}

/// webkit/wkdownloaddelegate — macOS 11.3+
///
/// `download(_:decideDestinationUsing:suggestedFilename:completionHandler:)`
/// is the one required member; the other two are `optional` on Apple's
/// platforms and get default implementations here for the same reason the
/// navigation delegate's do.
public protocol WKDownloadDelegate: AnyObject {
    /// webkit/wkdownloaddelegate/download(_:decidedestinationusing:suggestedfilename:completionhandler:)
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    )
}

extension WKDownloadDelegate {
    /// webkit/wkdownloaddelegate/download(_:didfailwitherror:resumedata:)
    public func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {}
    /// webkit/wkdownloaddelegate/downloaddidfinish(_:)
    public func downloadDidFinish(_ download: WKDownload) {}
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
    /// webkit/wkwebview/isinspectable — macOS 13.3+, default false
    @available(macOS 13.3, *)
    open var isInspectable: Bool {
        get { false }
        set {}
    }
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

    /// webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-19mn2
    ///
    /// The response overload. Same note about the handler's attributes.
    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {}

    /// webkit/wknavigationdelegate/webview(_:navigationaction:didbecome:) — macOS 11.3+
    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {}

    /// webkit/wknavigationdelegate/webview(_:navigationresponse:didbecome:) — macOS 11.3+
    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {}

    /// webkit/wknavigationdelegate/webview(_:didfail:witherror:)
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {}

    /// webkit/wknavigationdelegate/webview(_:didfailprovisionalnavigation:witherror:)
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {}
}

/// webkit/wkframeinfo
open class WKFrameInfo: NSObject {
    /// webkit/wkframeinfo/ismainframe
    open var isMainFrame: Bool { true }
    /// webkit/wkframeinfo/request
    open var request: URLRequest { URLRequest(url: URL(string: "about:blank")!) }
}

/// webkit/wkopenpanelparameters — macOS 10.12+
open class WKOpenPanelParameters: NSObject {
    /// webkit/wkopenpanelparameters/allowsmultipleselection
    open var allowsMultipleSelection: Bool { false }
    /// webkit/wkopenpanelparameters/allowsdirectories
    open var allowsDirectories: Bool { false }
}

/// webkit/wkuidelegate
public protocol WKUIDelegate: AnyObject {}

extension WKUIDelegate {
    /// webkit/wkuidelegate/webview(_:runopenpanelwith:initiatedbyframe:completionhandler:) — macOS 10.12+
    ///
    /// "By default on macOS, file uploads are disabled if you don't implement
    /// this method." Same note as the navigation delegate about the handler's
    /// attributes.
    public func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {}
}
