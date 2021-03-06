'use strict';

const Canvas = require('../interface/canvas');
const Node = require('../node/baseNode');
const $ = require('jquery');
const _ = require('lodash');
const Edge = require('../edge/baseEdge');
const Group = require('../group/baseGroup');
const Layout = require('../utils/layout');
const SelectCanvas = require('../utils/selectCanvas');
// 画布和屏幕坐标地换算
const CoordinateService = require('../utils/coordinate');

require('./baseCanvas.less');

class BaseCanvas extends Canvas {
  constructor(options) {
    super(options);
    this.root = options.root;
    this.layout = options.layout; // layout部分也需要重新review
    this.zoomable = options.zoomable || false;        // 可缩放
    this.moveable = options.moveable || false;        // 可平移
    this.draggable = options.draggable || false;      // 可拖动
    this.linkable = options.linkable || false;        // 可连线
    this.disLinkable = options.disLinkable || false;  // 可拆线

    this.css = options.css || {}; // 这部分需要废弃,因为复写了jsplumb这个模块
    this.theme = {
      edge: {
        type: _.get(options, 'theme.edge.type') || 'Bezier',
        Class: _.get(options, 'theme.edge.Class') || Edge
      },
      endpoint: {
        position: _.get(options, 'theme.endpoint.position')
      }
    };

    // 放大缩小和平移的数值
    this._zoomData = 1;
    this._moveData = [0, 0];

    this.groups = [];
    this.nodes = [];
    this.edges = [];

    // 框选模式，需要重新考虑(默认单选)
    this.isSelectMode = false;
    this.selecModel = [];
    this.selectItem = {
      nodes: [],
      edges: [],
      groups: [],
      endpoints: []
    };
    // 框选前需要纪录状态
    this._remarkZoom = undefined;
    this._remarkMove = undefined;

    this.svg = null;
    this.warpper = null;
    this.canvasWarpper = null;
    // 加一层warpper方便处理缩放，平移
    this._genWarpper();
    // 加一层svg画线条
    this._genSvgWarpper();
    // 加一层canvas方便处理辅助
    this._genCanvasWarpper();

    // 统一处理画布拖动事件
    this._dragType = null;
    this._dragNode = null;
    this._dragEndpoint = null;
    this._dragEdge = null; 

    // 初始化一些参数
    this._rootOffsetX = $(this.root).offset().left;
    this._rootOffsetY = $(this.root).offset().top;
    this._rootWidth = $(this.root).width();
    this._rootHeight = $(this.root).height();

    // this.terOffsetX = opts.terOffsetX || 0;
    // this.terOffsetY = opts.terOffsetY || 0;
    // this.terWidth = opts.terWidth || 0;
    // this.terHeight = opts.terHeight || 0;
    // this.canOffsetX = 0;
    // this.canOffsetY = 0;
    // this.scale = 1;
    this._coordinateService = new CoordinateService({
      terOffsetX: $(this.root).offset().left,
      terOffsetY: $(this.root).offset().top,
      terWidth: $(this.root).width(),
      terHeight: $(this.root).height(),
      canOffsetX: this._moveData[0],
      canOffsetY: this._moveData[1],
      scale: this._zoomData
    });

    this._addEventLinster();

    this.unionItem = {
      nodes: [],
      edges: [],
      groups: []
    };
  }

  draw(opts) {

    let groups = opts.groups || [];
    let nodes = opts.nodes || [];
    let edges = opts.edges || [];

    // 自动布局需要重新review
    if (this.layout) {
      this._autoLayout({
        groups,
        nodes,
        edges
      });
    }

    // 首次加载，异步逐步加载

    setTimeout(() => {
      // 生成groups
      this.addGroups(groups);
    });
    setTimeout(() => {
      // 生成nodes
      this.addNodes(nodes);
    }, 10);
    setTimeout(() => {
      // 生成edges
      this.addEdges(edges);
    }, 20);
  }

  getNode(id) {
    return _.find(this.nodes, (item) => {
      return item.id === id;
    });
  }
  getEdge(id) {
    return _.find(this.edges, (item) => {
      return item.id === id;
    });
  }
  getGroup(id) {
    return _.find(this.groups, (item) => {
      return item.id === id;
    });
  }
  addGroup(group) {
    let container = $(this.warpper);
    let GroupClass = group.Class || Group;
    let _groupObj = new GroupClass(_.assign(_.cloneDeep(group), {
      _emit: this.emit.bind(this),
      _on: this.on.bind(this),
    }));
    if (this._isExistGroup(_groupObj)) {
      // 后续用新的group代码旧的group
      console.log('group:' + _groupObj.id + 'has existed' );
      return ;
    }
    _groupObj.init();
    container.prepend(_groupObj.dom);

    this.groups.push(_groupObj);
    return _groupObj;
  }

  addNodes(nodes, isNotEventEmit) {
    
    let _canvasFragment = document.createDocumentFragment();
    let container = $(this.warpper);
    let result = nodes.map((node) => {
      let _nodeObj = null;
      if (node instanceof Node) {
        _nodeObj = node;
      } else {
        let _Node = node.Class || Node;
        _nodeObj = new _Node(_.assign(_.cloneDeep(node), {
          _on: this.on.bind(this),
          _emit: this.emit.bind(this),
          draggable: this.draggable
        }));
      }

      if (this._isExistNode(_nodeObj)) {
        // 后续用新的node代码旧的node
        console.log('node:' + _nodeObj.id + ' has existed' );
        return ;
      }

      // 节点初始化
      _nodeObj._init();

      // 假如节点存在group，即放进对应的节点组里
      let existGroup = _nodeObj.group ? this.getGroup(_nodeObj.group) : null;
      if (!!existGroup) {
        existGroup.addNode(_nodeObj, existGroup.id);
      } else {
        _canvasFragment.appendChild(_nodeObj.dom);
      }

      this.nodes.push(_nodeObj);
      return _nodeObj;
    });

    // 批量插入dom，性能优化
    container.append(_canvasFragment);

    result.forEach((item) => {
      // 渲染endpoint
      item._createEndpoint(isNotEventEmit);

      // 节点挂载
      item.mounted && item.mounted();
    });
    return result;
  }

  addNode(node, isNotEventEmit) {
    return this.addNodes([node], isNotEventEmit)[0];
  }

  addEdges(links) {
    $(this.svg).css('display', 'none');

    let _edgeFragment = document.createDocumentFragment();
    let _labelFragment = document.createDocumentFragment();
    let _arrowFragment = document.createDocumentFragment();

    let result = links.map((link) => {
      let EdgeClass = this.theme.edge.Class;
      
      if (link.type === 'endpoint') {
        let sourceNode = this.getNode(link.sourceNode);
        let targetNode = this.getNode(link.targetNode);
        let sourceEndpoint = sourceNode.getEndpoint(link.source);
        let targetEndpoint = targetNode.getEndpoint(link.target);

        let sourceGroup;
        let targetGroup;
        if (sourceNode.group) {
          sourceGroup = this.getGroup(sourceNode.group);
        }
        if (targetNode.group) {
          targetGroup = this.getGroup(targetNode.group);
        }

        if (!sourceEndpoint || !targetEndpoint) {
          console.log('butterflies error: can not connect edge. link sourceId:' + link.source + ';link targetId:' + link.target);
          return;
        }

        let edge = new EdgeClass({
          type: 'endpoint',
          id: link.id,
          label: link.label,
          shapeType: link.shapeType || this.theme.edge.type,
          orientationLimit: this.theme.endpoint.position,
          sourceNode: sourceNode,
          targetNode: targetNode,
          sourceEndpoint: sourceEndpoint,
          targetEndpoint: targetEndpoint,
          sourceGroup: sourceGroup,
          targetGroup: targetGroup,
          arrow: link.arrow,
          arrowPosition: link.arrowPosition,
          options: link,
          _on: this.on.bind(this),
          _emit: this.emit.bind(this),
        });
        edge._init();

        _edgeFragment.appendChild(edge.dom);

        if (edge.labelDom) {
          _labelFragment.appendChild(edge.labelDom);
        }

        if (edge.arrowDom) {
          _arrowFragment.appendChild(edge.arrowDom);
        }

        this.edges.push(edge);

        return edge;
      } else {
        let sourceNode = this.getNode(link.source);
        let targetNode = this.getNode(link.target);
        let sourceGroup;
        let targetGroup;

        if (sourceNode.group) {
          sourceGroup = this.getGroup(sourceNode.group);
        }
        if (targetNode.group) {
          targetGroup = this.getGroup(targetGroup.group);
        }

        if (!sourceNode || !targetNode) {
          console.log('butterflies error: can not connect edge. link sourceId:' + link.source + ';link targetId:' + link.target);
          return;
        }

        let edge = new EdgeClass({
          type: 'node',
          id: link.id,
          label: link.label,
          sourceNode: sourceNode,
          targetNode: targetNode,
          sourceGroup: sourceGroup,
          targetGroup: targetGroup,
          shapeType: link.shapeType || this.theme.edge.type,
          orientationLimit: this.theme.endpoint.position,
          arrow: link.arrow,
          arrowPosition: link.arrowPosition,
          _on: this.on.bind(this),
          _emit: this.emit.bind(this),
        });
        edge._init();
        
        _edgeFragment.appendChild(edge.dom);

        if (edge.labelDom) {
          _labelFragment.appendChild(edge.labelDom);
        }

        if (edge.arrowDom) {
          _arrowFragment.appendChild(edge.arrowDom);
        }

        this.edges.push(edge);

        return edge;
      }
    }).filter((item) => {
      return item;
    });

    $(this.svg).append(_edgeFragment, _arrowFragment);

    $(this.warpper).append(_labelFragment);

    result.forEach((link) => {
      let _soucePoint = {};
      let _targetPoint = {};
      if (link.type === 'endpoint') {
        _soucePoint = {
          pos: [link.sourceEndpoint._posLeft + link.sourceEndpoint._width / 2, link.sourceEndpoint._posTop + link.sourceEndpoint._height / 2]
        };
        _targetPoint = {
          pos: [link.targetEndpoint._posLeft + link.targetEndpoint._width / 2, link.targetEndpoint._posTop + link.targetEndpoint._height / 2]
        };
      } else if (link.type === 'node') {
        _soucePoint = {
          pos: [link.sourceNode.left + link.sourceNode.getWidth() / 2, link.sourceNode.top + link.sourceNode.getHeight() / 2]
        };

        _targetPoint = {
          pos: [link.targetNode.left + link.targetNode.getWidth() / 2, link.targetNode.top + link.targetNode.getHeight() / 2]
        };
      }
      link.redraw(_soucePoint, _targetPoint);
    });

    $(this.svg).css('display', 'block');
    return result;
  }

  addEdge(link) {
    return this.addEdges([link])[0];
  }

  addGroups(datas) {
    return datas.map((item) => {
      return this.addGroup(item);
    }).filter((item) => {
      return item;
    });
  }

  removeNode(nodeId, isNotDelEdge, isNotEventEmit) {
    let index = _.findIndex(this.nodes, (_node) => {
      return _node.id === nodeId;
    });
    if (index === -1) {
      console.log('找不到id为：' + nodeId + '的节点');
      return;
    }

    // 删除邻近的线条
    let neighborEdges = this.getNeighborEdges(nodeId);
    if (!isNotDelEdge) {
      this.edges = this.edges.filter((edge) => {
        let _edge = _.find(neighborEdges, (item) => {
          return item.id === edge.id;
        });
        return !!!_edge;
      });

      neighborEdges.forEach((item) => {
        item.destroy(isNotEventEmit);
      });
    }

    // 删除节点
    let node = this.nodes[index];
    node.destroy(isNotEventEmit);

    let _rmNodes = this.nodes.splice(index, 1);
    // 假如在group里面
    if (node.group) {
      let group = this.getGroup(node.group);
      if (group) {
        group.nodes = group.nodes.filter((item) => {
          return item.id !== node.id;
        });
      }
    }

    if (_rmNodes.length > 0) {
      return {
        nodes: [_rmNodes[0]],
        edges: neighborEdges,
      };
    } else {
      return {
        nodes: [],
        edges: []
      };
    }
  }

  removeNodes(nodeIds, isNotDelEdge, isNotEventEmit) {
    let rmNodes = [];
    let rmEdges = [];
    nodeIds.map((id) => {
      return this.removeNode(id, isNotDelEdge, isNotEventEmit);
    }).forEach((result) => {
      rmNodes = rmNodes.concat(result.nodes);
      rmEdges = rmEdges.concat(result.edges);
    });
    return {
      nodes: rmNodes,
      edges: rmEdges
    };
  }

  removeEdge(edgeId) {
    let edgeIndex = _.findIndex(this.edges, (item) => {
      return item.id === edgeId;
    });
    if (edgeIndex !== -1) {
      let edge = this.edges[edgeIndex];
      this.edges = this.edges.filter((item) => {
        return item.id !== edgeId;
      });
      edge.destroy();
      return edge;
    } else {
      console.log(`删除线条错误，不存在id为${edgeId}的线`);
    }
  }

  removeEdges(edgeIds) {
    return edgeIds.map((item) => {
      return this.removeEdge(item);
    }).filter((item) => {
      return item;
    });
  }

  removeGroup(groupId) {
    let index = _.findIndex(this.groups, (_group) => {
      return _group.id === groupId;
    });
    // 删除group
    let group = this.groups.splice(index, 1)[0];
    // group.offEvents();

    this.nodes.forEach((node) => {
      if (node.group === group.id) {
        node.top = node.top + group.top;
        node.left = node.left + group.top;
        delete node.group;
      }
    });
    this.emit('system.node.delete', {
      node: group
    });
    this.emit('events', {
      type: 'node:delete',
      node: group
    });
  }

  getNeighborEdges(nodeId) {
    let node = _.find(this.nodes, (item) => {
      return nodeId === item.id;
    });

    return this.edges.filter((item) => {
      return _.get(item, 'sourceNode.id') === node.id || _.get(item, 'targetNode.id') === node.id;
    });
  }

  getNeighborNodes(nodeId) {
    let result = [];
    let node = _.find(this.nodes, (item) => {
      return nodeId === item.id;
    });
    if (!node) {
      console.log(`找不到id为${nodeId}的节点`);
    }
    this.edges.forEach((item) => {
      if (item.sourceNode.id === nodeId) {
        result.push(item.targetNode.id);
      } else if (item.targetNode.id === nodeId) {
        result.push(item.sourceNode.id);
      }
    });

    return result.map((id) => {
      return this.getNode(id);
    });
  }
  setZoomable(flat) {
    if (!this._zoomCb) {
      this._zoomCb = (event) => {

        event.preventDefault();
        let deltaY = event.deltaY;
        this._zoomData += deltaY * 0.01;
  
        if (this._zoomData < 0.25) {
          this._zoomData = 0.25;
          return;
        } else if (this._zoomData > 5) {
          this._zoomData = 5;
          return;
        }
  
        let platform = ['webkit', 'moz', 'ms', 'o'];
        let scale = 'scale(' + this._zoomData + ')';
        for (var i = 0; i < platform.length; i++) {
          this.warpper.style[platform[i] + 'Transform'] = scale;
        }
        this.warpper.style['transform'] = scale;
        this._coordinateService._changeCanvasInfo({
          scale: this._zoomData
        });
      };
    }

    if (flat) {
      this.root.addEventListener('wheel', this._zoomCb);
    } else {
      this.root.removeEventListener('wheel', this._zoomCb);
    }
  }

  setMoveable(flat) {
    if (!!flat) {
      this.moveable = true;
      if (this._dragType === 'canvas:drag') {
        this.moveable = false;
      }
    } else {
      this.moveable = false;
    }
  }

  focusNodeWithAnimate(param, type = 'node', callback) {
    let node = null;

    if (_.isFunction(param)) { // 假如传入的是filter，则按照用户自定义的规则来寻找
      node = type === 'node' ? _.find(this.nodes, param) : _.find(this.groups, param);
    } else { // 假如传入的是id，则按照默认规则寻找
      node = type === 'node' ? _.find(this.nodes, (item) => {
        return item.id === param;
      }) : _.find(this.groups, (item) => {
        return item.id === param;
      });
    }

    let top = 0;
    let left = 0;
    if (!node) {
      return;
    } else {
      top = node.top || node.y;
      left = node.left || node.x;
      if (node.height) {
        top += node.height / 2;
      }
      if (node.width) {
        left += node.width / 2;
      }

      if (node.group) {
        let group = _.find(this.groups, (_group) => {
          return _group.id === node.group;
        });
        if (!group) return;
        top += group.top || group.y;
        left += group.left || group.x;
        if (group.height) {
          top += group.height / 2;
        }
        if (group.width) {
          left += group.width / 2;
        }
      }
    }

    let containerW = this._rootWidth;
    let containerH = this._rootHeight;

    let targetY = containerH / 2 - top;
    let targetX = containerW / 2 - left;

    let time = 500;
    
    // animate不支持scale，使用setInterval自己实现
    $(this.warpper).animate({
      top: targetY,
      left: targetX,
    }, time);
    this._moveData = [targetX, targetY];
    
    this.zoom(1, callback);

    this._coordinateService._changeCanvasInfo({
      canOffsetX: targetX,
      canOffsetY: targetY,
      scale: 1
    });
  }

  zoom(param, callback) {
    if (param < 0.25) {
      return;
    } else if (param > 5) {
      return;
    }
    let time = 50;
    let frame = 0;
    let gap = param - this._zoomData;
    let interval = gap / 20;
    let timer = null;
    if (gap !== 0) {
      timer = setInterval(() => {
        if (frame === 20) {
          clearInterval(timer);
          callback && callback();
        }
        this._zoomData += interval;
        this._coordinateService._changeCanvasInfo({
          scale: this._zoomData
        });
        $(this.warpper).css({
          'transform': 'scale(' + this._zoomData + ')'
        });
        frame++;
      }, time / 20);
    }
  }
  move(position) {
    $(this.warpper)
      .css('left', position[0])
      .css('top', position[1]);
    this._coordinateService._changeCanvasInfo({
      canOffsetX: position[0],
      canOffsetY: position[1]
    });
    this._moveData = position;
  }
  getZoom() {
    return this._zoomData;
  }
  getMovePosition()  {
    return this._moveData;
  }
  getDataMap() {
    return {
      nodes: this.nodes,
      edges: this.edges,
      groups: this.groups
    };
  }
  setSelectMode(flat = true, type = ['node']) {
    if (flat) {
      this.isSelectMode = true;
      this.selecModel = type;
      this.canvasWarpper.active();
      this._remarkMove = this.moveable;
      this._remarkZoom = this.zoomable;
      this.setZoomable(false);
      this.setMoveable(false);
    } else {
      this.isSelectMode = false;
      this.canvasWarpper.unActive();

      if (this._remarkMove) {
        this.setMoveable(true);
      }
      if (this._remarkZoom) {
        this.setZoomable(true);
      }
      this.unionItem = {
        nodes: [],
        edges: [],
        groups: []
      };
    }
  }
  add2Union(obj) {
    let item = null;
    switch (obj.type) {
      case 'node':
        item = this.getNode(obj.id);
        item && (this.unionItem.nodes.push(item));
        break;
      case 'group':
        item = this.getGroup(obj.id);
        item && (this.unionItem.groups.push(item));
        break;
      case 'edge':
        item = this.getEdge(obj.id);
        item && (this.unionItem.edges.push(item));
        break;
    }
    // if (item) {
    //   this.unionItem.push(item);
    // }
  }
  rmFromUnion(obj) {

  }
  _genSvgWarpper() {
    // 生成svg的warpper
    let svg = $(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
      .attr('class', 'butterfly-svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('version', '1.1')
      // .css('position', 'absolute')
      .attr('xmlns', 'http://www.w3.org/2000/svg')
      .appendTo(this.warpper);
    return this.svg = svg;
  }
  _genWarpper() {
    // 生成warpper
    let warpper = $('<div class="butterfly-warpper"></div>')
                    .appendTo(this.root);
    return this.warpper = warpper[0];
  }
  _genCanvasWarpper() {
    // 生成canvas warpper
    this.canvasWarpper = new SelectCanvas();
    this.canvasWarpper.init({
      root: this.root,
      _on: this.on.bind(this),
      _emit: this.emit.bind(this)
    });
  }
  _addEventLinster() {
    if (this.zoomable) {
      this.setZoomable(true);
    }
    if (this.moveable) {
      this.setMoveable(true);
    }

    $(window).resize(() => {
      this._rootWidth = $(this.root).width();
      this._rootHeight = $(this.root).height();
    });

    $(this.warpper).on('click', (e) => {
      this.emit('system.canvas.click');
      this.emit('events', {
        type: 'canvas:click'
      });
    });

    // 绑定一大堆事件，group:addMember，groupDragStop，group:removeMember，beforeDetach，connection，
    this.on('InnerEvents', (data) => {
      if (data.type === 'node:addEndpoint') {
        this._addEndpoint(data.data, data.isInited);
      } else if (data.type === 'node:dragBegin') {
        this._dragType = 'node:drag';
        this._dragNode = data.data;
      } else if (data.type === 'group:dragBegin') {
        this._dragType = 'group:drag';
        this._dragNode = data.data;
      } else if (data.type === 'endpoint:linkBegin') {
        this._dragType = 'endpoint:drag';
        this._dragEndpoint = data.data;
      } else if (data.type === 'multiple:select') {
        let result = this._selectMytiplyItem(data.range);
        this.emit('system.multiple.select', {
          data: result
        });
        this.emit('events', {
          type: 'multiple:select',
          data: result
        });

        // 把框选的加到union的数组
        this.unionItem = this.selectItem;
        
        this.selectItem = {
          nodes: [],
          edges: [],
          endpoints: []
        };
      }
    });

    // 绑定拖动事件
    this._attachMouseDownEvent();
  }
  _isExistNode(node) {
    let hasNodes = this.nodes.filter((item) => {
      return item.id === node.id;
    });
    return hasNodes.length > 0;
  }
  _isExistGroup(group) {
    let hasGroups = this.groups.filter((item) => {
      return item.id === group.id;
    });
    return hasGroups.length > 0;
  }
  _addEndpoint(endpoint, isInited) {
    endpoint._init({
      _coordinateService: this._coordinateService
    });

    // 非自定义dom，自定义dom不需要定位
    if (!endpoint._isInitedDom) {
      let endpointDom = endpoint.dom;
      if (endpoint._node.group) {
        let group = this.getGroup(endpoint._node.group);
        $(group.dom).append(endpointDom);
      } else {
        $(this.warpper).prepend(endpointDom);
      }
      endpoint.updatePos();
    }
  }
  _attachMouseDownEvent() {
    let originPos = {
      x: 0,
      y: 0
    };

    let rootOffsetX = this._rootOffsetX;
    let rootOffsetY = this._rootOffsetY;

    let rootWidth = this._rootWidth;
    let rootHeight = this._rootHeight;

    let mouseDownEvent = (event) => {
      const LEFT_BUTTON = 0;
      if (event.button !== LEFT_BUTTON) {
        return;
      }

      if (!this._dragType && this.moveable) {
        this._dragType = 'canvas:drag';
      }
      let originLeft = $(this.warpper).css('left');
      let originTop = $(this.warpper).css('top');
      originPos = {
        x: event.clientX - parseInt(originLeft),
        y: event.clientY - parseInt(originTop)
      };
      this.emit('system.drag.start', {
        dragType: this._dragType
      });
      this.emit('events', {
        type: 'drag:start',
        dragType: this._dragType
      });
    };

    let mouseMoveEvent = (event) => {
      const LEFT_BUTTON = 0;
      if (event.button !== LEFT_BUTTON) {
        return;
      }

      if (this._dragType) {
        let canvasX = this._coordinateService.terminal2canvas('x', event.clientX);
        let canvasY = this._coordinateService.terminal2canvas('y', event.clientY);
        let offsetX = canvasX - originPos.x;
        let offsetY = canvasY - originPos.y;
        if (this._dragType === 'canvas:drag') {
          this.move([event.clientX - originPos.x, event.clientY - originPos.y]);
        } else if (this._dragType === 'node:drag') {
          if (originPos.x === 0 && originPos.y === 0) {
            originPos = {
              x: canvasX,
              y: canvasY
            };
            return;
          }
          originPos = {
            x: canvasX,
            y: canvasY
          };
          if (this._dragNode) {
            let moveNodes = [this._dragNode];
            let isUnion = _.find(this.unionItem.nodes, (_node) => {
              return _node.id === this._dragNode.id;
            });
            if (isUnion) {
              moveNodes = this.unionItem.nodes;
            }
            $(this.svg).css('display', 'none');
            $(this.warpper).css('display', 'none');
            moveNodes.forEach((node) => {
              node.moveTo(node.left + offsetX, node.top + offsetY);
              $(this.svg).css('display', 'none');
              this.edges.forEach((edge) => {
                if (edge.type === 'endpoint') {
                  let isLink = _.find(node.endpoints, (point) => {
                    return point.id === edge.sourceEndpoint.id || point.id === edge.targetEndpoint.id;
                  });
                  isLink && edge.redraw();
                } else {
                  if (edge.sourceNode.id === node.id || edge.targetNode.id === node.id) {
                    edge.redraw();
                  }
                }
              });
            });
            $(this.svg).css('display', 'block');
            $(this.warpper).css('display', 'block');
            // let node = this._dragNode;
            // node.moveTo(node.left + offsetX, node.top + offsetY);
            // $(this.svg).css('display', 'none');
            // this.edges.forEach((edge) => {
            //   if (edge.type === 'endpoint') {
            //     let isLink = _.find(node.endpoints, (point) => {
            //       return point.id === edge.sourceEndpoint.id || point.id === edge.targetEndpoint.id;
            //     });
            //     isLink && edge.redraw();
            //   } else {
            //     if (edge.sourceNode.id === node.id || edge.targetNode.id === node.id) {
            //       edge.redraw();
            //     }
            //   }
            // });
            // $(this.svg).css('display', 'block');
          }
        } else if (this._dragType === 'group:drag') {
          if (originPos.x === 0 && originPos.y === 0) {
            originPos = {
              x: canvasX,
              y: canvasY
            };
            return;
          }
          originPos = {
            x: canvasX,
            y: canvasY
          };
          if (this._dragNode) {
            let group = this._dragNode;
            group.moveTo(group.left + offsetX, group.top + offsetY);
            this.edges.forEach((edge) => {
              if (edge.sourceNode.group === group.id || edge.targetNode.group === group.id) {
                edge.redraw();
              }
            });
          }
        } else if (this._dragType === 'endpoint:drag') {
          let beginX = this._dragEndpoint._posLeft + this._dragEndpoint._width / 2;
          let beginY = this._dragEndpoint._posTop + this._dragEndpoint._height / 2;

          let endX = this._coordinateService.terminal2canvas('x', event.clientX);
          let endY = this._coordinateService.terminal2canvas('y', event.clientY);

          let edge = null;
          if (!this._dragEdge) {
            let EdgeClass = this.theme.edge.Class;
            edge = this._dragEdge = new EdgeClass({
              shapeType: this.theme.edge.type,
              orientationLimit: this.theme.endpoint.position,
              _on: this.on.bind(this),
              _emit: this.emit.bind(this),
            });
            edge._init();
            $(this.svg).append(edge.dom);
          } else {
            edge = this._dragEdge;
          }
          let _soucePoint = {
            pos: [beginX, beginY]
          };
          let _targetPoint = {
            pos: [endX, endY],
          };
          if (edge.labelDom) {
            $(this.warpper).append(edge.labelDom);
          }
          if (edge.arrowDom) {
            $(this.svg).append(edge.arrowDom);
          }
          edge.redraw(_soucePoint, _targetPoint);
        }
        this.emit('system.drag.move', {
          dragType: this._dragType,
          pos: [event.clientX, event.clientY],
          dragNode: this._dragNode,
          dragEndpoint: this._dragEndpoint,
          dragEdge: this._dragEdge
        });
        this.emit('events', {
          type: 'drag:move',
          dragType: this._dragType,
          pos: [event.clientX, event.clientY],
          dragNode: this._dragNode,
          dragEndpoint: this._dragEndpoint,
          dragEdge: this._dragEdge
        });
      }
    };

    let mouseEndEvent = (event) => {

      const LEFT_BUTTON = 0;
      if (event.button !== LEFT_BUTTON) {
        return;
      }

      // 处理线条的问题
      if (this._dragEdge) {

        // 释放对应画布上的x,y
        let x = this._coordinateService.terminal2canvas('x', event.clientX);
        let y = this._coordinateService.terminal2canvas('y', event.clientY);

        let _targetEndpoint = null;

        this.nodes.forEach((_node) => {
          if (_node.endpoints) {
            _node.endpoints.forEach((_point) => {
              let _maxX = _point._posLeft + _point._width + 10;
              let _maxY = _point._posTop + _point._height + 10;
              let _minX = _point._posLeft - 10;
              let _minY = _point._posTop - 10;
              if (x > _minX && x < _maxX && y > _minY && y < _maxY) {
                _targetEndpoint = _point;
                return;
              }
            });
          }
        });
        // 找不到点 || scope不同 || 目标节点不是target 
        if (!_targetEndpoint || _targetEndpoint.scope !== this._dragEndpoint.scope || _targetEndpoint.type !== 'target') {
          this._dragEdge.destroy();
        } else {
          this._dragEdge._create({
            id: this._dragEndpoint.id + '-' + _targetEndpoint.id,
            sourceNode: this.getNode(this._dragEndpoint.nodeId),
            sourceEndpoint: this._dragEndpoint,
            targetNode: this.getNode(_targetEndpoint.nodeId),
            targetEndpoint: _targetEndpoint,
            type: 'endpoint'
          });
          this.edges.push(this._dragEdge);
          this.emit('system.link.connect', {
            link: this._dragEdge
          });
          this.emit('events', {
            type: 'link:connect',
            link: this._dragEdge
          });
        }
      }
      if (this._dragType === 'node:drag' && this._dragNode) {

        let sourceGroup = null;

        let _nodeLeft = this._dragNode.left;
        let _nodeRight = this._dragNode.left + this._dragNode.getWidth();
        let _nodeTop = this._dragNode.top;
        let _nodeBottom = this._dragNode.top + this._dragNode.getHeight();

        if (this._dragNode.group) {
          let _group = this.getGroup(this._dragNode.group);
          let _groupLeft = _group.left;
          let _groupRight = _group.left + _group.getWidth();
          let _groupTop = _group.top;
          let _groupBottom = _group.top + _group.getHeight();
          // if (_nodeLeft > _groupRight || _nodeRight < _groupLeft || _nodeTop > _groupBottom || _nodeBottom < _groupTop) {
          //   _nodeLeft += _groupLeft;
          //   _nodeTop += _groupTop;
          //   sourceGroup = _group;
          // }
          if (_nodeRight < 0 || _nodeLeft > _group.getWidth() || _nodeBottom < 0 || _nodeTop > _group.getHeight()) {
            _nodeLeft += _groupLeft;
            _nodeTop += _groupTop;
            _nodeRight += _groupLeft;
            _nodeBottom += _groupTop;
            sourceGroup = _group;
          }
        }

        let targetGroup = null;
        for (let i = 0; i < this.groups.length; i++) {
          let _group = this.groups[i];
          let _groupLeft = _group.left;
          let _groupRight = _group.left + _group.getWidth();
          let _groupTop = _group.top;
          let _groupBottom = _group.top + _group.getHeight();
          if (_groupLeft <= _nodeLeft && _groupRight >= _nodeRight && _groupTop <= _nodeTop && _groupBottom >= _nodeBottom) {
            if (_group.id !== this._dragNode.group) {
              targetGroup = _group;
              break;
            }
          }
        }

        let neighborEdges = [];
        if (sourceGroup) {
          let rmItem = this.removeNode(this._dragNode.id, true, true);
          let rmNode = rmItem.nodes[0];
          neighborEdges = rmItem.edges;
          let nodeData = {
            top: _nodeTop,
            left: _nodeLeft,
            _isDeleteGroup: true
          };

          if (targetGroup) {
            nodeData.top -= targetGroup.top;
            nodeData.left -= targetGroup.left;
            nodeData['group'] = targetGroup.id;
            nodeData['_isDeleteGroup'] = false;
          }
          rmNode._init(nodeData);
          this.addNode(rmNode, true);
        } else {
          if (targetGroup) {
            let rmItem = this.removeNode(this._dragNode.id, true, true);
            let rmNode = rmItem.nodes[0];
            neighborEdges = rmItem.edges;
            rmNode._init({
              top: _nodeTop - targetGroup.top,
              left: _nodeLeft - targetGroup.left,
              group: targetGroup.id
            });
            this.addNode(rmNode, true);
          }
        }
        neighborEdges.forEach((item) => {
          item.redraw();
        });
      }

      this.emit('system.drag.end', {
        dragType: this._dragType
      });
      this.emit('events', {
        type: 'drag:end',
        dragType: this._dragType
      });

      this._dragType = null;
      this._dragNode = null;
      this._dragEndpoint = null;
      this._dragEdge = null;
      originPos = {
        x: 0,
        y: 0
      };
    };


    this.root.addEventListener('mousedown', mouseDownEvent);
    this.root.addEventListener('mousemove', mouseMoveEvent);
    // this.root.addEventListener('mouseout', mouseEndEvent);
    this.root.addEventListener('mouseup', mouseEndEvent);
  }
  _autoLayout(data) {
    let width = this._rootWidth;
    let height = this._rootHeight;

    let _opts = $.extend({
      // 布局画布总宽度
      width: width,
      // 布局画布总长度
      height: height,
      // 布局相对中心点
      center: {
        x: width / 2,
        y: height / 2
      },
      // 节点互斥力，像电荷原理一样
      chargeStrength: -150,
      link: {
        // 以node的什么字段为寻找id，跟d3原理一样
        id: 'id',
        // 线条的距离
        distance: 200,
        // 线条的粗细
        strength: 1
      }
    }, _.get(this.layout, 'options'), true);

    // 自动布局
    if (_.get(this.layout, 'type') === 'forceLayout') {
      Layout.forceLayout({
        opts: _opts,
        data: {
          groups: data.groups,
          nodes: data.nodes,
          // 加工线条数据，兼容endpoint为id的属性，d3没这个概念
          edges: data.edges.map((item) => {
            return {
              source: item.type === 'endpoint' ? item.sourceNodeCode : item.source,
              target: item.type === 'endpoint' ? item.targetNodeCode : item.target
            };
          })
        }
      });
    }
  }
  _selectMytiplyItem(range) {

    // 确认一下终端的偏移值
    let startX = this._coordinateService.terminal2canvas('x', range[0]);
    let startY = this._coordinateService.terminal2canvas('y', range[1]);
    let endX = this._coordinateService.terminal2canvas('x', range[2]);
    let endY = this._coordinateService.terminal2canvas('y', range[3]);
    
    let includeNode = _.includes(this.selecModel, 'node');
    let includeEdge = _.includes(this.selecModel, 'edge');
    let includeEndpoint = _.includes(this.selecModel, 'endpoint');
    // 框选节点
    if (includeNode) {
      this.nodes.forEach((item) => {
        let nodeLeft = item.left;
        let nodeRight = item.left + $(item.dom).width();
        let nodeTop = item.top;
        let nodeBottom = item.top + $(item.dom).height();
        if (startX < nodeLeft && endX > nodeRight && startY < nodeTop && endY > nodeBottom) {
          this.selectItem.nodes.push(item);
        }
      });
    }

    // 框选锚点
    if (includeEndpoint) {
      this.nodes.forEach((node) => {
        node.endpoints.forEach((item) => {
          let pointLeft = item._posLeft;
          let pointRight = item._posLeft + $(item.dom).width();
          let pointTop = item._posTop;
          let pointBottom = item._posTop + $(item.dom).height();
          if (startX < pointLeft && endX > pointRight && startY < pointTop && endY > pointBottom) {
            this.selectItem.endpoints.push(item);
          }
        });
      });
    }

    // 框选线条
    if (includeEdge) {
      this.edges.forEach((item) => {
        if (item.type === 'endpoint') {
          let left = item.sourceEndpoint._posLeft < item.targetEndpoint._posLeft ? item.sourceEndpoint._posLeft : item.targetEndpoint._posLeft;
          let right = (item.sourceEndpoint._posLeft + item.sourceEndpoint._width) > (item.targetEndpoint._posLeft + item.targetEndpoint._width) ? (item.sourceEndpoint._posLeft + item.sourceEndpoint._width) : (item.targetEndpoint._posLeft + item.targetEndpoint._width);
          let top = item.sourceEndpoint._posTop < item.targetEndpoint._posTop ? item.sourceEndpoint._posTop : item.targetEndpoint._posTop;
          let bottom = (item.sourceEndpoint._posTop + item.sourceEndpoint._height) > (item.targetEndpoint._posTop + item.targetEndpoint._height) ? (item.sourceEndpoint._posTop + item.sourceEndpoint._height) : (item.targetEndpoint._posTop + item.targetEndpoint._height);
          if (startX < left && endX > right && startY < top && endY > bottom) {
            this.selectItem.edges.push(item);
          }
        } else if (item.type === 'node') {
          // 后续补
        }
      });
    }

    // 框选节点组，准备支持


    return this.selectItem;
  }
}

module.exports = BaseCanvas;
