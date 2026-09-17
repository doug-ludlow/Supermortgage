// Copy from docs/prototype/Supermortgage-Agent-Prototype.html, verbatim. Do not reword.

import Foundation

enum Copy {
    /// `SNIPS`: the header's working snippets.
    static let snippets: [String] = [
        "Checking this morning’s rates",
        "Reading your September statement",
        "Watching the county recorder",
        "Pricing your insurance renewal",
        "Waiting on your servicer about PMI",
        "Pooling a roof bid with your neighbors",
    ]

    /// `A.feedInstr`.
    static let feedInstructions = "Tell me what changed in my housing cost and why. Keep it short, no jargon. Only post when something moved or you need a yes."

    // MARK: Onboarding

    static let welcomeTitle = "Welcome to Supermortgage"
    static let welcomeSubtitle = "Your assistant, working tirelessly to take your monthly housing costs down to $0!"
    static let knowTitle = "Here’s how I work:"
    static let introPoints: [(title: String, body: String)] = [
        ("I upgrade your mortgage", "Automatically upgrades your current mortgage into a self-improving, automatically refinancing, lowest rate mortgage."),
        ("I help generate income", "Uses your home’s existing infrastructure to generate income every month."),
        ("I eliminate costs and fees", "Eliminates unnecessary or duplicative costs — PMI, subscription fees, idle escrow and more."),
    ]
    static let termsPrefix = "By continuing, you agree to the "
    static let termsLink1 = "Supermortgage Terms"
    static let termsMiddle = " and the "
    static let termsLink2 = "Privacy Policy"
    static let termsSuffix = ". Fictional data only."
    static let getStarted = "Get started"
    static let setupTitle = "Setting up your agent"

    // MARK: Chat script

    static func intro1(owner: String) -> String {
        "Hey \(owner), I’m your personal agent. My job is to take your monthly housing cost to $0."
    }
    static let introLead = "A bit about how I work:"
    static let introBullets: [String] = [
        "With your approval, I can refinance your mortgage, cancel what you don’t need, and put your home to work.",
        "I have my own computer and browser, so I keep working when you’re away.",
        "The longer we work together, the more I find.",
    ]
    static let nameAsk = "What would you like to call me? You can always change this later."
    static func nameChosen(_ name: String) -> String { "\(name) it is. I like it." }
    static let firstAsk = "To get started I need three things. First, your mortgage or lease."
    static let creditAsk = "Next: can I check your credit? It’s a soft pull — it won’t affect your score."
    static let creditDeclined = "No problem — I’ll ask again when it matters for a refinance."
    static let plaidAsk = "Last one: connect your accounts so I can see what the house actually costs you each month."
    static let numberLead = "Your monthly housing cost is"
    static let findingsLead = "Here’s what I found on the first pass:"
    static let actionsMessage = "I’ve cancelled the two subscriptions and requested the escrow refund — those didn’t need a yes. The PMI cancellation does."
    static let refinanceOffer = "One more thing. Rates are at 5.75% this morning, three-eighths under yours. A refinance would take about $164 a month off your payment and pays back in under a year. I can start it now."
    static let escrowApprovedMessage = "Update: the escrow refund is approved. $412 lands as a credit on your October statement."
    static let roofPoolMessage = "Your street: four homes are on Supermortgage now. I’m pooling a roof bid for next spring — nothing needed from you yet."
    static let pmiSent = "Sent. Your servicer has 30 days to respond; I follow up on day 15 and day 30, and I’ll tell you the moment it clears."
    static let refiOpening = "Opening the refinance. I’ve filled in what I already know; you’ll confirm a few things and I take it from there."
    static let refiHandedBack = "I’ve got it from here. I’ll lock when pricing is best and text you before anything binding."
    static let notYetReply = "Okay. I’ll keep watching every morning and only bring it up again if it gets better than this."

    // MARK: answer()

    static let answerHuman = "A person is one tap away. I’ll set up a call with your home team and send them what we’ve done so far."
    static let answerRefiStarted = "The refinance is in progress. I’m watching pricing hourly and will ask you before I lock."
    static let answerRefiOffered = "Rates are 5.75% this morning against your 6.125%. The refinance is ready whenever you are — about $164 a month."
    static let answerPMIRequested = "PMI cancellation was sent today. Your servicer has 30 days; I follow up on day 15 and day 30."
    static let answerPMIReady = "PMI can come off — you’re at 70% of value. I just need your yes."
    static func answerInsurance(renewal: String) -> String {
        "Your policy renews \(renewal). I start quotes February 1 with five carriers, and I’ll re-run your rebuild cost and mitigation discounts at the same time. Want them sooner?"
    }
    static let answerTax = "You’re assessed at $392,000 against a value near $410,000, so there’s no appeal case this year. The window opens July 2027; I watch comps monthly and your homeowners’ exemption is on file."
    static let answerIncome = "On the earning side: a compute site check is scheduled for Sep 24, your lot allows a detached ADU, and the driveway would earn about $95 a month nearby. Solar pays back in about nine years at SMUD rates. Say which of those you want the numbers on."
    static let answerPaused = "Paused. I’ll keep watching but won’t act on anything until you turn me back on."
    static let answerDefault = "Got it. I’ll look into it and post to your feed when there’s something to show."

    // MARK: Feed

    static let feedInstructionsTitle = "Feed instructions"
    static let feedInstructionsIntro = "Your feed is powered by the instructions below. Any edits you make apply to future posts."
    static let feedEmptyTitle = "Your feed isn’t ready yet"
    static let feedEmptyBody = "Posts appear here as I learn your home — what changed in your number and why."
    static let whyPostBar = "This post met the bar because your number moved or something needed a yes."

    // MARK: Goals

    static let goalsIntro = "Tell me what you’re after and I’ll build a plan that evolves with you."
    static let goalSheetIntro = "Tell me a little about what you’re after and I’ll build a plan that evolves with you."
    static let goalOpenIntro = "I’m building this plan. It shows up here with dates and dollars as soon as I have them, and the Work list changes to match."
    static let sparkFine = "Solid: what has happened. Dashed: the plan through next summer, an estimate."

    // MARK: Agent sheet

    static let activityEmpty = "Nothing yet. Everything I do shows up here with a time."
    static let permissionsFine = "On means I can do it without asking. Off means I bring you a card first."
    static let memoryIntro = "What I know about your home. Edit anything that’s wrong."
    static let pauseEverything = "Pause everything"
    static let pauseEverythingSmall = "I keep watching but stop acting"

    /// `memoryText()`.
    static func memoryText() -> String {
        """
        Home: \(Home.address) · single-family · 1,640 sq ft · built 1998 · no HOA
        Loan: Fannie Mae conforming · $287,400 · 6.125% fixed · \(Format.money(Home.payment, 2)) a month including escrow · PMI $146
        Value: about $410,000 (AVM, Sep 2026) · LTV 70%
        People: \(Home.owner), owner-occupant
        Accounts: Northstar Bank — checking, savings, card
        Insurance: renews \(Home.renewal) · $2,140 a year
        Utilities: SMUD, city water · not connected yet
        Preferences: ask before anything binding · buffer not set · tenants: undecided
        """
    }

    // MARK: Settings / About / Invite / Plaid

    static let howItMakesMoney = "Supermortgage is free to use. It only makes money when it’s able to save you money — for example, when it refinances you at a lower rate, it earns a servicing fee on the new mortgage. No fee comes from you."
    static let aboutWhat = "The AI assistant who works tirelessly to take your monthly housing cost down to $0."
    static let aboutHow = "Give it access to your mortgage or rental information, your credit, and your accounts. From there it runs its tasks daily, weekly, monthly and quarterly, all with one goal: your monthly housing cost, down."
    static let aboutKinds: [(label: String, text: String)] = [
        ("Upgrade", " — your current mortgage becomes a self-improving, automatically refinancing mortgage."),
        ("Income", " — your home’s existing infrastructure earns money designed to offset costs."),
        ("Eliminate", " — unnecessary or duplicative costs go away: PMI, subscriptions, idle escrow."),
    ]
    static let aboutMoney = "It’s free. It only makes money when it saves you money — a servicing fee on a new, lower-rate mortgage."
    static let aboutFine = "Prototype. Fictional data only."
    static let inviteIntro = "Homes on the same street get better prices on insurance, roofs and solar when they buy together. Four homes on Juniper Lane are on Supermortgage already."
    static let inviteLink = "supermortgage.com/j/juniper-lane"
    static let plaidIntro = "Choose the accounts I can read. I never move money without a card."
    static let plaidAccounts: [(title: String, sub: String)] = [
        ("Checking · 4821", "Where your paycheck lands"),
        ("Savings · 2210", "Your reserves"),
        ("Credit card · 7731", "Where the subscriptions are"),
    ]
    static let scheduleIntro = "Your home team can call you today or tomorrow. I’ll send them what we’ve done so far."
    static let scheduleSlots = ["Today, 4:30 PM", "Tomorrow, 9:00 AM"]

    // MARK: Approval

    static let approvalHeading = "Request PMI cancellation from your servicer"
    static let approvalIntro = "Based on the current value of your home. This is the only thing I need from you today."
    static let approvalRows: [KeyValue] = [
        KeyValue(key: "Current value (AVM)", value: "$410,000"),
        KeyValue(key: "Balance", value: "$287,400"),
        KeyValue(key: "Loan-to-value", value: "70%"),
        KeyValue(key: "Saves", value: "$146 a month"),
        KeyValue(key: "What I send", value: "The request letter and the valuation"),
        KeyValue(key: "What happens next", value: "Servicer has 30 days · I follow up day 15 and 30"),
    ]

    // MARK: Artifacts

    static func pmiLetter(sent: Bool) -> String {
        """
        \(sent ? "Sent September 17, 2026" : "DRAFT")

        To: Loan servicing, PMI cancellation
        Re: Loan ending 4417 · 24 Juniper Lane, Sacramento, CA 95816

        Please cancel private mortgage insurance on this loan based on the current value of the property. The unpaid balance is $287,400. The current value is $410,000 (automated valuation attached), a loan-to-value of 70%, below the 80% threshold for borrower-requested cancellation based on current value. Payments are current and the loan is seasoned more than two years.

        Please confirm the cancellation and the refund of any unearned premium within 30 days.
        """
    }
    static let refiFine = "Fannie Mae conforming, 30-year fixed. No points. Appraisal waiver used. The next refinance happens the same way when rates drop again."
    static func insuranceIntro() -> String {
        "Quotes from five carriers begin February 1. With them I re-run your rebuild cost, set the deductible to your reserves, and document the water shutoff for its discount. Current premium: $2,140 a year. Homes like yours on your street: about $1,400."
    }
    static let siteIntro = "What I’ll measure: panel capacity and spare breakers, a shaded exterior wall or the pool for heat, bandwidth, and the easement footprint. You’ll get the numbers the same day — what the site can host and what it would pay against your mortgage."
    static let taxIntro = "Assessed $392,000; value near $410,000. I keep pulling comps monthly. If comps drop below your assessment before the July 2027 window, the packet is ready to file the day it opens."

    // MARK: Refinance cover (§5.10)

    static let refinanceTitle = "Your current home."
    static let handingOff = "Handing your file to the platform…"
}
