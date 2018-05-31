/**
 * Vida6 - An ES6-compatible controller for Verovio
 *
 * VidaView: A UI region which displays a single SVG representation of an MEI document
 * Authors: Andrew Horwitz
 *
 * Required options on initialization:
 * -controller: the previously constructed VidaController object
 * -parentElement: a DOM element inside which the VidaView should be constructed
 *
 * Optional options:
 * -mei: the MEI to initially load into this VidaView; can be set/changed after instantiation using VidaView:refreshVerovio
 * -iconClasses: extra classes to apply to toolbar buttons
 */

import {Events} from './utils';

export class VidaView
{
    constructor(options)
    {
        options = options || {};
        if (!options.controller || !options.parentElement)
            return console.error("All VidaView objects must be initialized with both the 'controller' and 'parentElement' parameters.");

        this.parentElement = options.parentElement;
        options.iconClasses = options.iconClasses || {};
        this.iconClasses = {
            nextPage: options.iconClasses.nextPage || '',
            prevPage: options.iconClasses.prevPage || '',
            zoomIn: options.iconClasses.zoomIn || '',
            zoomOut: options.iconClasses.zoomOut || ''
        };

        this.controller = options.controller;
        this.viewIndex = this.controller.register(this);

        // One of the little quirks of writing in ES6, bind events
        this.bindListeners();

        // initializes ui underneath the parent element, as well as Verovio communication
        this.initializeLayoutAndWorker();

        // Initialize the events system and alias the functions
        this.events = new Events();
        this.publish = this.events.publish;
        this.subscribe = this.events.subscribe;
        this.unsubscribe = this.events.unsubscribe;

        this.verovioSettings = {
            // Formatting for line breaks and identifying that we're working with MEI
            breaks: 'auto',
            inputFormat: 'mei',

            // Conserve space for the viewer by not showing a footer and capping the page height
            adjustPageHeight: true,
            noFooter: true,

            // These are all default values and are overridden further down in `VidaView:refreshVerovio`
            pageHeight: 2970,
            pageWidth: 2100,
            pageMarginLeft: 50,
            pageMarginRight: 50,
            pageMarginTop: 50,
            pageMarginBottom: 50,
            scale: 100
        };

        // "Global" variables
        this.resizeTimer;
        this.mei = undefined; // saved in Vida as well as the worker; there are cases where Verovio's interpretation
        this.verovioContent = undefined; // svg output

        // Vida ensures one system per Verovio page; track the current system/page and total count
        this.currentSystem = 0; // topmost system object within the Vida display
        this.totalSystems = 1; // total number of system objects; we can safely assume it'll be at least one

        // For dragging
        this.draggingActive; // boolean "active"
        this.highlightedCache = [];
        this.dragInfo = {

        /*
            "x": position of clicked note
            "initY": initial Y position
            "svgY": scaled initial Y position
            "pixPerPix": conversion between the above two
        */

        };

        if (options.mei) this.refreshVerovio(options.mei);
    }

    destroy()
    {
        window.addEventListener('resize', this.boundResize);

        this.ui.svgOverlay.removeEventListener('scroll', this.boundSyncScroll);
        this.ui.nextPage.removeEventListener('click', this.boundGotoNext);
        this.ui.prevPage.removeEventListener('click', this.boundGotoPrev);
        this.ui.zoomIn.removeEventListener('click', this.boundZoomIn);
        this.ui.zoomOut.removeEventListener('click', this.boundZoomOut);

        this.ui.svgOverlay.removeEventListener('click', this.boundObjectClick);
        const notes = this.ui.svgOverlay.querySelectorAll('.note');
        for (var idx = 0; idx < notes.length; idx++)
        {
            const note = notes[idx];

            note.removeEventListener('mousedown', this.boundMouseDown);
            note.removeEventListener('touchstart', this.boundMouseDown);
        }

        document.removeEventListener('mousemove', this.boundMouseMove);
        document.removeEventListener('mouseup', this.boundMouseUp);
        document.removeEventListener('touchmove', this.boundMouseMove);
        document.removeEventListener('touchend', this.boundMouseUp);

        this.events.unsubscribeAll();
    }

    /**
     * Init code separated out for cleanliness' sake
     */
    initializeLayoutAndWorker()
    {
        this.ui = {
            parentElement: this.parentElement, // must be DOM node
            svgWrapper: undefined,
            svgOverlay: undefined,
            controls: undefined
        };

        this.ui.parentElement.innerHTML = '<div class="vida-wrapper">' +
            '<div class="vida-toolbar">' +
                '<div class="vida-page-controls vida-toolbar-block">' +
                    '<div class="vida-button vida-prev-page vida-direction-control ' + this.iconClasses.prevPage + '"></div>' +
                    '<div class="vida-button vida-next-page vida-direction-control ' + this.iconClasses.nextPage + '"></div>' +
                '</div>' +
                '<div class="vida-zoom-controls vida-toolbar-block">' +
                    '<span class="vida-button vida-zoom-in vida-zoom-control ' + this.iconClasses.zoomIn + '"></span>' +
                    '<span class="vida-button vida-zoom-out vida-zoom-control ' + this.iconClasses.zoomOut + '"></span>' +
                '</div>' +
            '</div>' +
            '<div class="vida-svg-wrapper vida-svg-object" style="z-index: 1; position:absolute;">Verovio is loading...</div>' +
            '<div class="vida-svg-overlay vida-svg-object" style="z-index: 1; position:absolute;"></div>' +
        '</div>';

        window.addEventListener('resize', this.boundResize);

        // If this has already been instantiated , undo events
        if (this.ui && this.ui.svgOverlay) this.destroy();

        // Set up the UI object
        this.ui.svgWrapper = this.ui.parentElement.querySelector('.vida-svg-wrapper');
        this.ui.svgOverlay = this.ui.parentElement.querySelector('.vida-svg-overlay');
        this.ui.controls = this.ui.parentElement.querySelector('.vida-page-controls');
        this.ui.nextPage = this.ui.parentElement.querySelector('.vida-next-page');
        this.ui.prevPage = this.ui.parentElement.querySelector('.vida-prev-page');
        this.ui.zoomIn = this.ui.parentElement.querySelector('.vida-zoom-in');
        this.ui.zoomOut = this.ui.parentElement.querySelector('.vida-zoom-out');

        // synchronized scrolling between svg overlay and wrapper
        this.ui.svgOverlay.addEventListener('scroll', this.boundSyncScroll);

        // control bar events
        this.ui.nextPage.addEventListener('click', this.boundGotoNext);
        this.ui.prevPage.addEventListener('click', this.boundGotoPrev);
        this.ui.zoomIn.addEventListener('click', this.boundZoomIn);
        this.ui.zoomOut.addEventListener('click', this.boundZoomOut);

        // simulate a resize event
        this.updateDims();
    }

    // Necessary for how ES6 "this" works
    bindListeners()
    {
        this.boundSyncScroll = (evt) => this.syncScroll(evt);
        this.boundGotoNext = (evt) => this.gotoNextSystem(evt);
        this.boundGotoPrev = (evt) => this.gotoPrevSystem(evt);
        this.boundZoomIn = (evt) => this.zoomIn(evt);
        this.boundZoomOut = (evt) => this.zoomOut(evt);
        this.boundObjectClick = (evt) => this.objectClickListener(evt);

        this.boundMouseDown = (evt) => this.mouseDownListener(evt);
        this.boundMouseMove = (evt) => this.mouseMoveListener(evt);
        this.boundMouseUp = (evt) => this.mouseUpListener(evt);

        this.boundResize = (evt) => this.resizeComponents(evt);
    }

    /**
     * Code for contacting the controller; renderPage is used as the callback multiple times.
     */
    contactWorker(messageType, params, callback)
    {
        this.controller.contactWorker(messageType, params, this.viewIndex, callback);
    }

    renderPage(params)
    {
        const vidaOffset = this.ui.svgWrapper.getBoundingClientRect().top;
        this.ui.svgWrapper.innerHTML = params.svg;

        // create the overlay, save the content, make sure highlights are up to date
        if (params.createOverlay) this.createOverlay();
        this.verovioContent = this.ui.svgWrapper.innerHTML;
        this.reapplyHighlights();

        // do not reset this.mei to what Verovio thinks it should be, as that'll cause significant problems
        this.updateNavIcons();
        this.events.publish('PageRendered', [this.mei]);
    }

    updateSettings(rerender)
    {
        this.contactWorker('setOptions', {options: this.verovioSettings});
        if (rerender) this.renderCurrentPage();
    };

    // Used to reload Verovio, or to provide new MEI
    refreshVerovio(mei)
    {
        if (mei) this.mei = mei;
        if (!this.mei) return;

        this.ui.svgOverlay.innerHTML = this.ui.svgWrapper.innerHTML = this.verovioContent = '';

        // Verovio pageHeight should be the default regardless, but reset the pageWidth to be whatever the effective viewport width is
        this.verovioSettings.pageHeight = 
            this.ui.svgWrapper.clientHeight // base wrapper width
            * (100 / this.verovioSettings.scale) // make sure the system takes up the full available width
            - (this.verovioSettings.pageMarginTop + this.verovioSettings.pageMarginBottom); // minus margins

        this.verovioSettings.pageWidth = 
            this.ui.svgWrapper.clientWidth // base wrapper width
            * (100 / this.verovioSettings.scale) // make sure the system takes up the full available width
            - (this.verovioSettings.pageMarginLeft + this.verovioSettings.pageMarginRight); // minus margins

        this.updateSettings(false);
        this.contactWorker('loadData', {mei: this.mei + '\n'}, (params) =>
        {
            this.totalSystems = params.pageCount;
            this.currentSystem = Math.min(this.currentSystem, this.totalSystems);
            this.renderCurrentPage();
        });
    }

    createOverlay()
    {
        // Copy wrapper HTML to overlay
        this.ui.svgOverlay.innerHTML = this.ui.svgWrapper.innerHTML;

        // Make all <g>s and <path>s transparent, hide the text
        var idx;
        const gElems = this.ui.svgOverlay.querySelectorAll('g');
        for (idx = 0; idx < gElems.length; idx++)
        {
            gElems[idx].style.strokeOpacity = 0.0;
            gElems[idx].style.fillOpacity = 0.0;
        }
        const pathElems = this.ui.svgOverlay.querySelectorAll('path');
        for (idx = 0; idx < pathElems.length; idx++)
        {
            pathElems[idx].style.strokeOpacity = 0.0;
            pathElems[idx].style.fillOpacity = 0.0;
        }
        delete this.ui.svgOverlay.querySelectorAll('text');

        // Add event listeners for click
        this.ui.svgOverlay.removeEventListener('click', this.boundObjectClick);
        this.ui.svgOverlay.addEventListener('click', this.boundObjectClick);
        const notes = this.ui.svgOverlay.querySelectorAll('.note');
        for (idx = 0; idx < notes.length; idx++)
        {
            const note = notes[idx];

            note.removeEventListener('mousedown', this.boundMouseDown);
            note.removeEventListener('touchstart', this.boundMouseDown);
            note.addEventListener('mousedown', this.boundMouseDown);
            note.addEventListener('touchstart', this.boundMouseDown);
        }
    }

    updateNavIcons()
    {
        if (this.verovioSettings.noLayout || (this.currentSystem === this.totalSystems - 1)) this.ui.nextPage.style.visibility = 'hidden';
        else this.ui.nextPage.style.visibility = 'visible';

        if (this.verovioSettings.noLayout || (this.currentSystem === 0)) this.ui.prevPage.style.visibility = 'hidden';
        else this.ui.prevPage.style.visibility = 'visible';
    }

    updateZoomIcons()
    {
        if (this.verovioSettings.scale == 100) this.ui.zoomIn.style.visibility = 'hidden';
        else this.ui.zoomIn.style.visibility = 'visible';

        if (this.verovioSettings.scale == 10) this.ui.zoomOut.style.visibility = 'hidden';
        else this.ui.zoomOut.style.visibility = 'visible';
    }

    /**
     * Navigate to the next page
     */
    goToSystem(pageNumber)
    {
        this.currentSystem = pageNumber;
        this.renderCurrentPage();
    }

    renderCurrentPage()
    {
        this.contactWorker('renderPage', {pageIndex: this.currentSystem}, this.renderPage);
    }

    // Shortcurt for above with safety for max possible system
    gotoNextSystem()
    {
        if (this.currentSystem < (this.totalSystems - 1)) this.goToSystem(this.currentSystem + 1);
    }

    // Shortcurt for above with safety for min possible system
    gotoPrevSystem()
    {
        if (this.currentSystem > 0) this.goToSystem(this.currentSystem - 1);
    }

    /**
     * Event listeners - Display
     */
    resizeComponents()
    {
        // Immediately: resize larger components
        this.updateDims();

        // Set timeout for resizing Verovio once full resize action is complete
        clearTimeout(this.resizeTimer);
        const self = this;
        this.resizeTimer = setTimeout(function ()
        {
            self.refreshVerovio();
        }, 200);
    }

    /**
     * Because the svgWrapper and svgOverlay elements are both position:absolute, make sure they
     *  have the same positioning so that they can be overlaid and clicks can register on the
     *  correct notehead.
     */
    updateDims()
    {
        this.ui.svgOverlay.style.height = this.ui.svgWrapper.style.height = this.ui.parentElement.clientHeight - this.ui.controls.clientHeight;
        this.ui.svgOverlay.style.top = this.ui.svgWrapper.style.top = this.ui.controls.clientHeight;
        this.ui.svgOverlay.style.width = this.ui.svgWrapper.style.width = this.ui.parentElement.clientWidth;
    }

    /**
     * Similarly, in case of overflow, make sure that scrolling in the overlay (which this function
     *  is bound to) triggers the same scroll on the svgWrapper element too.
     */
    syncScroll(e)
    {
        this.ui.svgWrapper.scrollTop = e.target.scrollTop;
        this.ui.svgWrapper.scrollLeft = e.target.scrollLeft;
    }

    // Handles zooming in - subtract 10 from scale
    zoomIn()
    {
        if (this.verovioSettings.scale <= 100)
        {
            this.verovioSettings.scale += 10;
            this.updateSettings(true);
        }
    }

    // Handles zooming out - subtract 10 from scale
    zoomOut()
    {
        if (this.verovioSettings.scale > 10)
        {
            this.verovioSettings.scale -= 10;
            this.updateSettings(true);
        }
    }

    /**
     * Event listeners - Dragging
     */
    objectClickListener(e)
    {
        var closestMeasure = e.target.closest('.measure');
        if (closestMeasure) this.publish('ObjectClicked', [e.target, closestMeasure]);
        e.stopPropagation();
    }

    mouseDownListener(e)
    {
        var t = e.target;
        var id = t.parentNode.attributes.id.value;

        this.resetHighlights();
        this.activateHighlight(id);

        var viewBoxSVG = t.closest('svg');
        var parentSVG = viewBoxSVG.parentNode.closest('svg');
        var actualSizeArr = viewBoxSVG.getAttribute('viewBox').split(' ');
        var actualHeight = parseInt(actualSizeArr[3]);
        var svgHeight = parseInt(parentSVG.getAttribute('height'));
        var pixPerPix = (actualHeight / svgHeight);

        this.dragInfo['x'] = t.getAttribute('x') >> 0;
        this.dragInfo['svgY'] = t.getAttribute('y') >> 0;
        this.dragInfo['initY'] = e.pageY;
        this.dragInfo['pixPerPix'] = pixPerPix;

        // we haven't started to drag yet, this might be just a selection
        document.addEventListener('mousemove', this.boundMouseMove);
        document.addEventListener('mouseup', this.boundMouseUp);
        document.addEventListener('touchmove', this.boundMouseMove);
        document.addEventListener('touchend', this.boundMouseUp);
        this.draggingActive = false;
    };

    mouseMoveListener(e)
    {
        const scaledY = (e.pageY - this.dragInfo.initY) * this.dragInfo.pixPerPix;
        for (var idx = 0; idx < this.highlightedCache.length; idx++)
            this.ui.svgOverlay.querySelector('#' + this.highlightedCache[idx]).setAttribute('transform', 'translate(0, ' + scaledY + ')');

        this.draggingActive = true;
        e.preventDefault();
    };

    mouseUpListener(e)
    {
        document.removeEventListener('mousemove', this.boundMouseMove);
        document.removeEventListener('mouseup', this.boundMouseUp);
        document.removeEventListener('touchmove', this.boundMouseMove);
        document.removeEventListener('touchend', this.boundMouseUp);

        if (!this.draggingActive) return;
        this.commitChanges(e.pageY);
    }

    commitChanges(finalY)
    {
        for (var idx = 0; idx < this.highlightedCache.length; idx++)
        {
            const id = this.highlightedCache[idx];
            const obj = this.ui.svgOverlay.querySelector('#' + id);
            const scaledY = this.dragInfo.svgY + (finalY - this.dragInfo.initY) * this.dragInfo.pixPerPix;
            obj.style['transform'] =  'translate(' + [0, scaledY] + ')';
            obj.style['fill'] = '#000';
            obj.style['stroke'] = '#000';

            const editorAction = {
                action: 'drag',
                param: {
                    elementId: id,
                    x: parseInt(this.dragInfo.x),
                    y: parseInt(scaledY)
                }
            };

            this.contactWorker('edit', {action: editorAction, pageIndex: this.currentSystem}, this.renderPage);
            if (this.draggingActive) this.removeHighlight(id);
        }

        if (this.draggingActive)
        {
            this.contactWorker('renderPage', {pageIndex: this.currentSystem}, this.renderPage);
            this.draggingActive = false;
            this.dragInfo = {};
        }
    };

    activateHighlight(id)
    {
        if (this.highlightedCache.indexOf(id) > -1) return;

        this.highlightedCache.push(id);
        this.reapplyHighlights();

        // Hide the svgWrapper copy of the note
        this.ui.svgWrapper.querySelector('#' + id).setAttribute('style', 'fill-opacity: 0.0; stroke-opacity: 0.0;');
    }

    reapplyHighlights()
    {
        for (var idx = 0; idx < this.highlightedCache.length; idx++)
        {
            var targetObj = this.ui.svgOverlay.querySelector('#' + this.highlightedCache[idx]);
            targetObj.setAttribute('style', 'fill: #ff0000; stroke: #ff00000; fill-opacity: 1.0; stroke-opacity: 1.0;');
        }
    }

    removeHighlight(id)
    {
        var idx = this.highlightedCache.indexOf(id);
        if (idx === -1) return;

        var removedID = this.highlightedCache.splice(idx, 1);
        this.ui.svgWrapper.querySelector('#' + id).setAttribute('style', 'fill-opacity: 1.0; stroke-opacity: 1.0;');
        this.ui.svgOverlay.querySelector('#' + removedID).setAttribute('style', 'fill: #000000; stroke: #0000000; fill-opacity: 0.0; stroke-opacity: 0.0;');
    }

    resetHighlights()
    {
        while (this.highlightedCache[0]) this.removeHighlight(this.highlightedCache[0]);
    }
}